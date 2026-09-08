import { Annotations, CfnOutput, Stack, type StackProps } from "aws-cdk-lib";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as logs from "aws-cdk-lib/aws-logs";
import type { Construct } from "constructs";
import type { LangflowEnvironment } from "./config";

/** Port Langflow listens on inside the container (LANGFLOW_PORT). */
export const LANGFLOW_CONTAINER_PORT = 7860;

export interface NetworkStackProps extends StackProps {
  readonly config: LangflowEnvironment;
}

/**
 * The VPC every other stack lands in, plus every security group and the rules
 * between them.
 *
 * Three subnet tiers: public subnets hold only the load balancer and NAT
 * gateways, the Fargate tasks run in private-with-egress subnets, and Aurora,
 * Redis and EFS sit in isolated subnets with no route to the internet at all.
 *
 * All security groups are declared here rather than in the stack that owns the
 * resource they protect. A group defined next to its database and referenced by
 * the service stack would make the two stacks depend on each other, so the
 * groups live in the one stack that both of the others already depend on.
 */
export class NetworkStack extends Stack {
  public readonly vpc: ec2.Vpc;
  public readonly albSecurityGroup: ec2.SecurityGroup;
  public readonly serviceSecurityGroup: ec2.SecurityGroup;
  public readonly databaseSecurityGroup: ec2.SecurityGroup;
  public readonly redisSecurityGroup: ec2.SecurityGroup;
  public readonly fileSystemSecurityGroup: ec2.SecurityGroup;

  constructor(scope: Construct, id: string, props: NetworkStackProps) {
    super(scope, id, props);
    const { config } = props;

    // Ingress rules that name a group as their source also register a matching
    // egress rule, which is redundant on an allow-all-outbound group.
    Annotations.of(this).acknowledgeWarning("@aws-cdk/aws-ec2:ipv4IgnoreEgressRule");

    this.vpc = new ec2.Vpc(this, "Vpc", {
      vpcName: `langflow-${config.envName}`,
      ipAddresses: ec2.IpAddresses.cidr("10.42.0.0/16"),
      maxAzs: config.maxAzs,
      natGateways: config.natGateways,
      restrictDefaultSecurityGroup: true,
      subnetConfiguration: [
        { name: "public", subnetType: ec2.SubnetType.PUBLIC, cidrMask: 24 },
        { name: "app", subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS, cidrMask: 22 },
        { name: "data", subnetType: ec2.SubnetType.PRIVATE_ISOLATED, cidrMask: 24 },
      ],
    });

    // Rejected traffic only: enough to debug a security-group misconfiguration
    // without paying to store metadata for every accepted packet.
    this.vpc.addFlowLog("RejectFlowLog", {
      trafficType: ec2.FlowLogTrafficType.REJECT,
      destination: ec2.FlowLogDestination.toCloudWatchLogs(
        new logs.LogGroup(this, "FlowLogGroup", {
          logGroupName: `/langflow/${config.envName}/vpc-flow-logs`,
          retention: config.logRetention,
          removalPolicy: config.removalPolicy,
        }),
      ),
    });

    // Free, and keeps Langflow's file-storage traffic and ECR layer downloads
    // off the metered NAT gateway.
    this.vpc.addGatewayEndpoint("S3Endpoint", {
      service: ec2.GatewayVpcEndpointAwsService.S3,
      subnets: [
        { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
        { subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
      ],
    });

    if (config.enableVpcEndpoints) {
      const endpoints: Record<string, ec2.InterfaceVpcEndpointAwsService> = {
        EcrApi: ec2.InterfaceVpcEndpointAwsService.ECR,
        EcrDocker: ec2.InterfaceVpcEndpointAwsService.ECR_DOCKER,
        CloudWatchLogs: ec2.InterfaceVpcEndpointAwsService.CLOUDWATCH_LOGS,
        SecretsManager: ec2.InterfaceVpcEndpointAwsService.SECRETS_MANAGER,
        Ssm: ec2.InterfaceVpcEndpointAwsService.SSM,
      };
      for (const [name, service] of Object.entries(endpoints)) {
        this.vpc.addInterfaceEndpoint(`${name}Endpoint`, {
          service,
          subnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
          privateDnsEnabled: true,
        });
      }
    }

    // ------------------------------------------------------------------ Edge
    this.albSecurityGroup = new ec2.SecurityGroup(this, "AlbSecurityGroup", {
      vpc: this.vpc,
      securityGroupName: `langflow-${config.envName}-alb`,
      description: "Langflow public load balancer",
      allowAllOutbound: true,
    });
    for (const cidr of config.albIngressCidrs) {
      this.albSecurityGroup.addIngressRule(
        ec2.Peer.ipv4(cidr),
        ec2.Port.tcp(443),
        `HTTPS from ${cidr}`,
      );
      this.albSecurityGroup.addIngressRule(
        ec2.Peer.ipv4(cidr),
        ec2.Port.tcp(80),
        `HTTP from ${cidr} (redirected to HTTPS)`,
      );
    }

    // --------------------------------------------------------------- Compute
    // Outbound is open: flows call third-party model and tool APIs by design.
    this.serviceSecurityGroup = new ec2.SecurityGroup(this, "ServiceSecurityGroup", {
      vpc: this.vpc,
      securityGroupName: `langflow-${config.envName}-service`,
      description: "Langflow Fargate tasks",
      allowAllOutbound: true,
    });
    this.serviceSecurityGroup.addIngressRule(
      this.albSecurityGroup,
      ec2.Port.tcp(LANGFLOW_CONTAINER_PORT),
      "Langflow HTTP from the load balancer only",
    );

    // ------------------------------------------------------------------ Data
    this.databaseSecurityGroup = new ec2.SecurityGroup(this, "DatabaseSecurityGroup", {
      vpc: this.vpc,
      securityGroupName: `langflow-${config.envName}-database`,
      description: "Langflow Aurora cluster",
      allowAllOutbound: false,
    });
    this.databaseSecurityGroup.addIngressRule(
      this.serviceSecurityGroup,
      ec2.Port.tcp(5432),
      "PostgreSQL from Langflow tasks",
    );

    this.redisSecurityGroup = new ec2.SecurityGroup(this, "RedisSecurityGroup", {
      vpc: this.vpc,
      securityGroupName: `langflow-${config.envName}-redis`,
      description: "Langflow ElastiCache Redis",
      allowAllOutbound: false,
    });
    this.redisSecurityGroup.addIngressRule(
      this.serviceSecurityGroup,
      ec2.Port.tcp(6379),
      "Redis from Langflow tasks",
    );

    this.fileSystemSecurityGroup = new ec2.SecurityGroup(this, "FileSystemSecurityGroup", {
      vpc: this.vpc,
      securityGroupName: `langflow-${config.envName}-efs`,
      description: "Langflow EFS mount targets",
      allowAllOutbound: false,
    });
    this.fileSystemSecurityGroup.addIngressRule(
      this.serviceSecurityGroup,
      ec2.Port.tcp(2049),
      "NFS from Langflow tasks",
    );

    new CfnOutput(this, "VpcId", { value: this.vpc.vpcId });
  }
}
