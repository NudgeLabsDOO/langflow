import * as path from "node:path";
import {
  CfnOutput,
  Duration,
  IgnoreMode,
  RemovalPolicy,
  Stack,
  type StackProps,
} from "aws-cdk-lib";
import * as acm from "aws-cdk-lib/aws-certificatemanager";
import * as cloudwatch from "aws-cdk-lib/aws-cloudwatch";
import * as cwActions from "aws-cdk-lib/aws-cloudwatch-actions";
import type * as cognito from "aws-cdk-lib/aws-cognito";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as ecrAssets from "aws-cdk-lib/aws-ecr-assets";
import * as ecs from "aws-cdk-lib/aws-ecs";
import type * as efs from "aws-cdk-lib/aws-efs";
import * as elbv2 from "aws-cdk-lib/aws-elasticloadbalancingv2";
import * as elbv2Actions from "aws-cdk-lib/aws-elasticloadbalancingv2-actions";
import * as iam from "aws-cdk-lib/aws-iam";
import * as kms from "aws-cdk-lib/aws-kms";
import * as logs from "aws-cdk-lib/aws-logs";
import * as route53 from "aws-cdk-lib/aws-route53";
import * as route53Targets from "aws-cdk-lib/aws-route53-targets";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as secretsmanager from "aws-cdk-lib/aws-secretsmanager";
import type * as sns from "aws-cdk-lib/aws-sns";
import * as wafv2 from "aws-cdk-lib/aws-wafv2";
import type { Construct } from "constructs";
import type { LangflowEnvironment } from "./config";
import { LANGFLOW_CONTAINER_PORT } from "./network-stack";

export interface ServiceStackProps extends StackProps {
  readonly config: LangflowEnvironment;
  readonly vpc: ec2.IVpc;
  readonly albSecurityGroup: ec2.ISecurityGroup;
  readonly serviceSecurityGroup: ec2.ISecurityGroup;

  /**
   * Data-tier resources arrive as plain identifiers, not as constructs.
   *
   * Granting a role in this stack access to a construct owned by the data stack
   * makes CDK write the permission into that resource's own policy, which turns
   * the one-way dependency into a cycle. Re-importing each resource here keeps
   * every grant on the IAM principal, where it belongs.
   */
  readonly encryptionKeyArn: string;
  readonly databaseSecretArn: string;
  readonly langflowSecretKeyArn: string;
  readonly redisAuthSecretArn?: string;
  readonly fileBucketName: string;
  readonly fileSystem: efs.IFileSystem;
  readonly accessPoint: efs.IAccessPoint;
  readonly redisEndpoint?: string;
  readonly redisPort?: string;
  readonly alarmTopic: sns.ITopic;

  readonly userPool: cognito.IUserPool;
  readonly userPoolClient: cognito.IUserPoolClient;
  readonly userPoolDomain: cognito.IUserPoolDomain;
}

const EFS_MOUNT_PATH = "/mnt/langflow";
const EFS_VOLUME_NAME = "langflow-config";

/**
 * Langflow itself: the container, the load balancer that authenticates in front
 * of it, and the DNS name it answers on.
 *
 * Request path for a browser:
 *
 *   Route53 → ALB :443 → authenticate-cognito → Google → back to the ALB with a
 *   session cookie → forwarded to the task with `x-amzn-oidc-data`, an
 *   ALB-signed JWT carrying the user's claims → Langflow's external-identity
 *   layer maps those claims to a local user (creating it on first sign-in).
 *
 * Nothing that fails the Cognito handshake reaches the container, and the
 * container's security group only accepts traffic from the load balancer, so
 * the `x-amzn-oidc-*` headers cannot be spoofed by a direct request.
 */
export class ServiceStack extends Stack {
  public readonly loadBalancer: elbv2.ApplicationLoadBalancer;
  public readonly service: ecs.FargateService;
  public readonly url: string;

  constructor(scope: Construct, id: string, props: ServiceStackProps) {
    super(scope, id, props);
    const { config, vpc } = props;

    // Imported, so every grant below lands on the IAM principal only.
    const encryptionKey = kms.Key.fromKeyArn(this, "EncryptionKey", props.encryptionKeyArn);
    const fileBucket = s3.Bucket.fromBucketAttributes(this, "FileBucket", {
      bucketName: props.fileBucketName,
      encryptionKey,
    });
    const databaseSecret = secretsmanager.Secret.fromSecretAttributes(this, "DatabaseSecret", {
      secretCompleteArn: props.databaseSecretArn,
      encryptionKey,
    });
    const langflowSecretKey = secretsmanager.Secret.fromSecretAttributes(this, "LangflowSecretKey", {
      secretCompleteArn: props.langflowSecretKeyArn,
      encryptionKey,
    });
    const redisAuthSecret = props.redisAuthSecretArn
      ? secretsmanager.Secret.fromSecretAttributes(this, "RedisAuthSecret", {
          secretCompleteArn: props.redisAuthSecretArn,
          encryptionKey,
        })
      : undefined;

    // Load-balancer access logs are delivered by the ELB service account, which
    // needs a bucket policy CDK can only write on a bucket it owns.
    const accessLogBucket = new s3.Bucket(this, "AccessLogBucket", {
      bucketName: `langflow-${config.envName}-alb-logs-${this.account}`,
      encryption: s3.BucketEncryption.S3_MANAGED,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      lifecycleRules: [{ id: "expire", expiration: Duration.days(90) }],
      // Destroyed with the stack, even in prod. This is the stateless stack and
      // it has to stay freely recreatable: a retained bucket survives a rollback
      // and then blocks the next create, because the name is deterministic and
      // CloudFormation refuses to adopt a resource it does not own. These are
      // short-lived operational logs — the lifecycle rule already caps them at
      // 90 days — not business data, which lives in the data stack.
      removalPolicy: RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });

    const hostedZone = route53.HostedZone.fromLookup(this, "HostedZone", {
      domainName: config.hostedZoneName,
    });

    const certificate = new acm.Certificate(this, "Certificate", {
      domainName: config.domainName,
      validation: acm.CertificateValidation.fromDns(hostedZone),
    });

    // ------------------------------------------------------------- Container
    const image = this.resolveImage(config);

    const logGroup = new logs.LogGroup(this, "LogGroup", {
      logGroupName: `/langflow/${config.envName}/service`,
      retention: config.logRetention,
      encryptionKey,
      // Destroyed with the stack, like everything else here. The name is
      // deterministic, so a retained log group outlives a rollback and then
      // blocks the next create — CloudFormation will not adopt a resource it
      // does not own. Retention already bounds how much history exists; ship
      // logs downstream if they need to survive the stack.
      removalPolicy: RemovalPolicy.DESTROY,
    });

    const taskDefinition = new ecs.FargateTaskDefinition(this, "TaskDefinition", {
      family: `langflow-${config.envName}`,
      cpu: config.cpu,
      memoryLimitMiB: config.memoryMiB,
      runtimePlatform: {
        cpuArchitecture:
          config.cpuArchitecture === "ARM64"
            ? ecs.CpuArchitecture.ARM64
            : ecs.CpuArchitecture.X86_64,
        operatingSystemFamily: ecs.OperatingSystemFamily.LINUX,
      },
      // Component packages, model downloads and temporary flow artifacts land
      // on the task's scratch disk; the 20 GiB default is tight for the full
      // bundle image.
      ephemeralStorageGiB: 40,
      volumes: [
        {
          name: EFS_VOLUME_NAME,
          efsVolumeConfiguration: {
            fileSystemId: props.fileSystem.fileSystemId,
            transitEncryption: "ENABLED",
            authorizationConfig: {
              accessPointId: props.accessPoint.accessPointId,
              iam: "ENABLED",
            },
          },
        },
      ],
    });

    fileBucket.grantReadWrite(taskDefinition.taskRole);
    encryptionKey.grantEncryptDecrypt(taskDefinition.taskRole);

    // The execution role's KMS grant has to be written by hand.
    //
    // `Secret.grantRead` normally covers it, but it grants decrypt to a
    // `kms.ViaServicePrincipal` wrapper rather than to the role itself. That
    // has nowhere to land on an *imported* key: there is no principal policy
    // for a bare principal, and an imported key's policy cannot be edited. The
    // grant silently no-ops, and the failure surfaces only at runtime, as
    // "ResourceInitializationError ... AccessDeniedException: Access to KMS is
    // not allowed" when the agent tries to pull the secret.
    //
    // The key policy delegates kms:* to the account root, so a principal-side
    // grant is sufficient. The ViaService condition keeps it to exactly what
    // CDK would have written: decryption performed by Secrets Manager, not
    // direct use of the key by the execution role.
    taskDefinition.addToExecutionRolePolicy(
      new iam.PolicyStatement({
        sid: "DecryptSecretsManagerSecrets",
        actions: ["kms:Decrypt", "kms:DescribeKey"],
        resources: [props.encryptionKeyArn],
        conditions: {
          StringEquals: {
            "kms:ViaService": `secretsmanager.${this.region}.amazonaws.com`,
          },
        },
      }),
    );
    taskDefinition.taskRole.addToPrincipalPolicy(
      new iam.PolicyStatement({
        actions: [
          "elasticfilesystem:ClientMount",
          "elasticfilesystem:ClientWrite",
          "elasticfilesystem:DescribeMountTargets",
        ],
        resources: [props.fileSystem.fileSystemArn],
        conditions: {
          StringEquals: {
            "elasticfilesystem:AccessPointArn": props.accessPoint.accessPointArn,
          },
        },
      }),
    );
    // ECS Exec, so an operator can open a shell in a running task without SSH.
    taskDefinition.taskRole.addToPrincipalPolicy(
      new iam.PolicyStatement({
        actions: [
          "ssmmessages:CreateControlChannel",
          "ssmmessages:CreateDataChannel",
          "ssmmessages:OpenControlChannel",
          "ssmmessages:OpenDataChannel",
        ],
        resources: ["*"],
      }),
    );

    const container = taskDefinition.addContainer("langflow", {
      containerName: "langflow",
      image,
      logging: ecs.LogDrivers.awsLogs({ streamPrefix: "langflow", logGroup }),
      environment: this.buildEnvironment(props),
      secrets: buildSecrets({ databaseSecret, langflowSecretKey, redisAuthSecret }),
      entryPoint: ["/bin/sh", "-c"],
      command: [buildStartupScript(Boolean(props.redisEndpoint))],
      portMappings: [
        { containerPort: LANGFLOW_CONTAINER_PORT, protocol: ecs.Protocol.TCP, name: "http" },
      ],
      healthCheck: {
        command: [
          "CMD-SHELL",
          `curl -fsS http://127.0.0.1:${LANGFLOW_CONTAINER_PORT}/health || exit 1`,
        ],
        interval: Duration.seconds(30),
        timeout: Duration.seconds(10),
        retries: 3,
        // The full image imports every bundled provider on boot and may run
        // migrations; give it room before the first probe counts against it.
        startPeriod: Duration.minutes(5),
      },
      stopTimeout: Duration.seconds(60),
      ulimits: [{ name: ecs.UlimitName.NOFILE, softLimit: 65536, hardLimit: 65536 }],
    });
    container.addMountPoints({
      containerPath: EFS_MOUNT_PATH,
      sourceVolume: EFS_VOLUME_NAME,
      readOnly: false,
    });

    // ----------------------------------------------------------------- Service
    const cluster = new ecs.Cluster(this, "Cluster", {
      clusterName: `langflow-${config.envName}`,
      vpc,
      containerInsightsV2: config.enableContainerInsights
        ? ecs.ContainerInsights.ENABLED
        : ecs.ContainerInsights.DISABLED,
      enableFargateCapacityProviders: true,
    });

    this.service = new ecs.FargateService(this, "Service", {
      serviceName: `langflow-${config.envName}`,
      cluster,
      taskDefinition,
      desiredCount: config.desiredCount,
      securityGroups: [props.serviceSecurityGroup],
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      assignPublicIp: false,
      enableExecuteCommand: true,
      circuitBreaker: { enable: true, rollback: true },
      minHealthyPercent: 100,
      maxHealthyPercent: 200,
      // Migrations and provider imports make a cold task slow; do not let the
      // scheduler count it unhealthy while it is still booting.
      healthCheckGracePeriod: Duration.minutes(10),
      capacityProviderStrategies: [{ capacityProvider: "FARGATE", weight: 1 }],
    });

    const scaling = this.service.autoScaleTaskCount({
      minCapacity: config.minCount,
      maxCapacity: config.maxCount,
    });
    scaling.scaleOnCpuUtilization("CpuScaling", {
      targetUtilizationPercent: 65,
      scaleInCooldown: Duration.minutes(5),
      scaleOutCooldown: Duration.minutes(2),
    });
    scaling.scaleOnMemoryUtilization("MemoryScaling", {
      targetUtilizationPercent: 75,
      scaleInCooldown: Duration.minutes(5),
      scaleOutCooldown: Duration.minutes(2),
    });

    // ------------------------------------------------------------------- Edge
    this.loadBalancer = new elbv2.ApplicationLoadBalancer(this, "LoadBalancer", {
      loadBalancerName: `langflow-${config.envName}`,
      vpc,
      internetFacing: true,
      securityGroup: props.albSecurityGroup,
      vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
      // Flow builds stream results over SSE and websockets for minutes at a time.
      idleTimeout: Duration.seconds(600),
      dropInvalidHeaderFields: true,
      http2Enabled: true,
      // Deliberately off. The load balancer holds no state — the DNS record and
      // the data tier are what matter — and enabling it turns any failed create
      // into a stuck ROLLBACK_FAILED, because CloudFormation cannot delete the
      // half-built stack it just made.
      deletionProtection: false,
    });
    this.loadBalancer.logAccessLogs(accessLogBucket, `alb/${config.envName}`);

    const targetGroup = new elbv2.ApplicationTargetGroup(this, "TargetGroup", {
      vpc,
      port: LANGFLOW_CONTAINER_PORT,
      protocol: elbv2.ApplicationProtocol.HTTP,
      targetType: elbv2.TargetType.IP,
      targets: [this.service],
      deregistrationDelay: Duration.seconds(60),
      // Build events are streamed from an in-process queue, so a browser must
      // keep talking to the task that started its build.
      stickinessCookieDuration: config.ssoSessionTimeout,
      healthCheck: {
        path: "/health",
        healthyHttpCodes: "200",
        interval: Duration.seconds(30),
        timeout: Duration.seconds(10),
        healthyThresholdCount: 2,
        unhealthyThresholdCount: 5,
      },
    });

    this.loadBalancer.addRedirect({
      sourceProtocol: elbv2.ApplicationProtocol.HTTP,
      sourcePort: 80,
      targetProtocol: elbv2.ApplicationProtocol.HTTPS,
      targetPort: 443,
    });

    const authenticate = new elbv2Actions.AuthenticateCognitoAction({
      userPool: props.userPool,
      userPoolClient: props.userPoolClient,
      userPoolDomain: props.userPoolDomain,
      scope: "openid email profile",
      sessionTimeout: config.ssoSessionTimeout,
      onUnauthenticatedRequest: elbv2.UnauthenticatedAction.AUTHENTICATE,
      next: elbv2.ListenerAction.forward([targetGroup]),
    });

    const listener = this.loadBalancer.addListener("HttpsListener", {
      port: 443,
      protocol: elbv2.ApplicationProtocol.HTTPS,
      certificates: [certificate],
      sslPolicy: elbv2.SslPolicy.TLS13_RES,
      defaultAction: authenticate,
    });

    if (config.allowApiKeyBypass) {
      // Machine clients cannot complete a browser redirect flow. Requests that
      // carry an API key skip the OIDC gate and are authenticated by Langflow
      // itself against the api_key table. This widens the attack surface to
      // anyone who can reach the load balancer, so it is opt-in per environment.
      listener.addAction("ApiKeyBypass", {
        priority: 10,
        conditions: [
          elbv2.ListenerCondition.pathPatterns(["/api/*"]),
          elbv2.ListenerCondition.httpHeader("x-api-key", ["*"]),
        ],
        action: elbv2.ListenerAction.forward([targetGroup]),
      });
    }

    new route53.ARecord(this, "AliasRecord", {
      zone: hostedZone,
      recordName: config.domainName,
      target: route53.RecordTarget.fromAlias(
        new route53Targets.LoadBalancerTarget(this.loadBalancer),
      ),
      comment: `Langflow ${config.envName}`,
    });

    if (config.enableWaf) {
      this.attachWebAcl(config);
    }

    this.url = `https://${config.domainName}`;
    this.addServiceAlarms(config, props.alarmTopic, targetGroup);

    new CfnOutput(this, "Url", { value: this.url });
    new CfnOutput(this, "LoadBalancerDnsName", { value: this.loadBalancer.loadBalancerDnsName });
    new CfnOutput(this, "ClusterName", { value: cluster.clusterName });
    new CfnOutput(this, "ServiceName", { value: this.service.serviceName });
  }

  // --------------------------------------------------------------------------

  private resolveImage(config: LangflowEnvironment): ecs.ContainerImage {
    if (config.imageSource === "registry") {
      return ecs.ContainerImage.fromRegistry(config.registryImage!);
    }

    const asset = new ecrAssets.DockerImageAsset(this, "Image", {
      // The build context is the repository root: the Dockerfile copies the
      // uv workspace, every backend package and the frontend source.
      directory: path.join(__dirname, "..", ".."),
      file: "docker/build_and_push.Dockerfile",
      target: config.dockerTarget,
      platform:
        config.cpuArchitecture === "ARM64"
          ? ecrAssets.Platform.LINUX_ARM64
          : ecrAssets.Platform.LINUX_AMD64,
      // Beyond the repository .dockerignore: things that are large, irrelevant
      // to the build, and would otherwise churn the asset hash on every commit.
      exclude: [
        ".git",
        ".github",
        "docs",
        "infra/node_modules",
        "infra/cdk.out",
        "**/node_modules",
        "**/.venv",
        "**/cdk.out",
        "**/*.log",
      ],
      ignoreMode: IgnoreMode.DOCKER,
    });
    return ecs.ContainerImage.fromDockerImageAsset(asset);
  }

  private buildEnvironment(props: ServiceStackProps): Record<string, string> {
    const { config } = props;

    return {
      // ---------------------------------------------------------- Server
      LANGFLOW_HOST: "0.0.0.0",
      LANGFLOW_PORT: String(LANGFLOW_CONTAINER_PORT),
      LANGFLOW_LOG_LEVEL: "INFO",
      DO_NOT_TRACK: "true",

      // ------------------------------------------------------------ Auth
      // Every request arrives already authenticated by the load balancer, so
      // the built-in single-user bypass and self-registration stay off.
      LANGFLOW_AUTO_LOGIN: "false",
      LANGFLOW_ENABLE_SIGNUP: "false",
      LANGFLOW_ENABLE_SUPERUSER_CLI: "false",
      LANGFLOW_NEW_USER_IS_ACTIVE: "true",

      // Trust the ALB-signed identity header. `x-amzn-oidc-data` is a JWT the
      // load balancer mints from the Cognito/Google claims and overwrites on
      // every request, so a client cannot inject its own. Signature
      // verification is skipped because the ALB publishes its keys as bare PEM
      // files rather than a JWKS document — the security boundary is instead
      // that the task's security group accepts traffic only from the ALB.
      LANGFLOW_EXTERNAL_AUTH_ENABLED: "true",
      LANGFLOW_EXTERNAL_AUTH_PROVIDER: "cognito-google",
      LANGFLOW_EXTERNAL_AUTH_TOKEN_HEADER: "x-amzn-oidc-data",
      LANGFLOW_EXTERNAL_AUTH_TRUSTED_JWT_DECODE: "true",
      LANGFLOW_EXTERNAL_AUTH_SUBJECT_CLAIM: "sub",
      LANGFLOW_EXTERNAL_AUTH_EMAIL_CLAIM: "email",
      LANGFLOW_EXTERNAL_AUTH_USERNAME_CLAIM: "email",
      LANGFLOW_EXTERNAL_AUTH_NAME_CLAIM: "name",

      LANGFLOW_ACCESS_SECURE: "true",
      LANGFLOW_REFRESH_SECURE: "true",
      LANGFLOW_ACCESS_SAME_SITE: "lax",
      LANGFLOW_REFRESH_SAME_SITE: "lax",

      // --------------------------------------------------------- Storage
      LANGFLOW_STORAGE_TYPE: "s3",
      LANGFLOW_OBJECT_STORAGE_BUCKET_NAME: props.fileBucketName,
      LANGFLOW_OBJECT_STORAGE_PREFIX: "files/",
      AWS_DEFAULT_REGION: this.region,

      // Knowledge bases and caches are written to disk, so the config dir is
      // the EFS mount rather than the task's ephemeral storage.
      LANGFLOW_CONFIG_DIR: EFS_MOUNT_PATH,
      LANGFLOW_KNOWLEDGE_BASES_DIR: `${EFS_MOUNT_PATH}/knowledge_bases`,
      LANGFLOW_SAVE_DB_IN_CONFIG_DIR: "false",

      // ----------------------------------------------------------- Cache
      LANGFLOW_CACHE_TYPE: props.redisEndpoint ? "redis" : "memory",
      ...(props.redisEndpoint ? { REDIS_HOST: props.redisEndpoint } : {}),
      ...(props.redisPort ? { REDIS_PORT: props.redisPort } : {}),

      ...config.extraEnvironment,
    };
  }

  private attachWebAcl(config: LangflowEnvironment): void {
    const webAcl = new wafv2.CfnWebACL(this, "WebAcl", {
      name: `langflow-${config.envName}`,
      scope: "REGIONAL",
      defaultAction: { allow: {} },
      visibilityConfig: {
        cloudWatchMetricsEnabled: true,
        metricName: `langflow-${config.envName}`,
        sampledRequestsEnabled: true,
      },
      rules: [
        {
          name: "AWSManagedRulesCommonRuleSet",
          priority: 1,
          overrideAction: { none: {} },
          statement: {
            managedRuleGroupStatement: {
              vendorName: "AWS",
              name: "AWSManagedRulesCommonRuleSet",
              // Flow definitions and file uploads are large JSON bodies that
              // legitimately trip these two rules.
              ruleActionOverrides: [
                { name: "SizeRestrictions_BODY", actionToUse: { count: {} } },
                { name: "CrossSiteScripting_BODY", actionToUse: { count: {} } },
              ],
            },
          },
          visibilityConfig: {
            cloudWatchMetricsEnabled: true,
            metricName: "common-rule-set",
            sampledRequestsEnabled: true,
          },
        },
        {
          name: "AWSManagedRulesKnownBadInputsRuleSet",
          priority: 2,
          overrideAction: { none: {} },
          statement: {
            managedRuleGroupStatement: {
              vendorName: "AWS",
              name: "AWSManagedRulesKnownBadInputsRuleSet",
            },
          },
          visibilityConfig: {
            cloudWatchMetricsEnabled: true,
            metricName: "known-bad-inputs",
            sampledRequestsEnabled: true,
          },
        },
        {
          name: "AWSManagedRulesAmazonIpReputationList",
          priority: 3,
          overrideAction: { none: {} },
          statement: {
            managedRuleGroupStatement: {
              vendorName: "AWS",
              name: "AWSManagedRulesAmazonIpReputationList",
            },
          },
          visibilityConfig: {
            cloudWatchMetricsEnabled: true,
            metricName: "ip-reputation",
            sampledRequestsEnabled: true,
          },
        },
        {
          name: "RateLimitPerIp",
          priority: 10,
          action: { block: {} },
          statement: {
            rateBasedStatement: { limit: 2000, aggregateKeyType: "IP" },
          },
          visibilityConfig: {
            cloudWatchMetricsEnabled: true,
            metricName: "rate-limit-per-ip",
            sampledRequestsEnabled: true,
          },
        },
      ],
    });

    new wafv2.CfnWebACLAssociation(this, "WebAclAssociation", {
      resourceArn: this.loadBalancer.loadBalancerArn,
      webAclArn: webAcl.attrArn,
    });
  }

  private addServiceAlarms(
    config: LangflowEnvironment,
    topic: sns.ITopic,
    targetGroup: elbv2.ApplicationTargetGroup,
  ): void {
    const action = new cwActions.SnsAction(topic);

    const unhealthy = new cloudwatch.Alarm(this, "UnhealthyTargetsAlarm", {
      alarmName: `langflow-${config.envName}-unhealthy-targets`,
      alarmDescription: "One or more Langflow tasks are failing their load balancer health check",
      metric: targetGroup.metrics.unhealthyHostCount({ period: Duration.minutes(1) }),
      threshold: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      evaluationPeriods: 3,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });
    unhealthy.addAlarmAction(action);

    const noHealthy = new cloudwatch.Alarm(this, "NoHealthyTargetsAlarm", {
      alarmName: `langflow-${config.envName}-no-healthy-targets`,
      alarmDescription: "Langflow is completely unavailable",
      metric: targetGroup.metrics.healthyHostCount({ period: Duration.minutes(1) }),
      threshold: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.LESS_THAN_THRESHOLD,
      evaluationPeriods: 2,
      treatMissingData: cloudwatch.TreatMissingData.BREACHING,
    });
    noHealthy.addAlarmAction(action);

    const serverErrors = new cloudwatch.Alarm(this, "TargetErrorAlarm", {
      alarmName: `langflow-${config.envName}-target-5xx`,
      alarmDescription: "Langflow is returning server errors",
      metric: targetGroup.metrics.httpCodeTarget(
        elbv2.HttpCodeTarget.TARGET_5XX_COUNT,
        { period: Duration.minutes(5), statistic: "Sum" },
      ),
      threshold: 25,
      evaluationPeriods: 2,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });
    serverErrors.addAlarmAction(action);

    const latency = new cloudwatch.Alarm(this, "LatencyAlarm", {
      alarmName: `langflow-${config.envName}-p95-latency`,
      metric: targetGroup.metrics.targetResponseTime({
        period: Duration.minutes(5),
        statistic: "p95",
      }),
      threshold: 10,
      evaluationPeriods: 3,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });
    latency.addAlarmAction(action);

    const dashboard = new cloudwatch.Dashboard(this, "Dashboard", {
      dashboardName: `langflow-${config.envName}`,
    });
    dashboard.addWidgets(
      new cloudwatch.GraphWidget({
        title: "Requests and errors",
        left: [
          this.loadBalancer.metrics.requestCount({ period: Duration.minutes(5) }),
          targetGroup.metrics.httpCodeTarget(elbv2.HttpCodeTarget.TARGET_5XX_COUNT, {
            period: Duration.minutes(5),
          }),
        ],
        width: 12,
      }),
      new cloudwatch.GraphWidget({
        title: "Target response time",
        left: [
          targetGroup.metrics.targetResponseTime({ period: Duration.minutes(5), statistic: "p50" }),
          targetGroup.metrics.targetResponseTime({ period: Duration.minutes(5), statistic: "p95" }),
        ],
        width: 12,
      }),
      new cloudwatch.GraphWidget({
        title: "Task utilisation",
        left: [
          this.service.metricCpuUtilization({ period: Duration.minutes(5) }),
          this.service.metricMemoryUtilization({ period: Duration.minutes(5) }),
        ],
        width: 12,
      }),
      new cloudwatch.GraphWidget({
        title: "Healthy targets",
        left: [targetGroup.metrics.healthyHostCount({ period: Duration.minutes(1) })],
        width: 12,
      }),
    );
  }
}

interface SecretSources {
  readonly databaseSecret: secretsmanager.ISecret;
  readonly langflowSecretKey: secretsmanager.ISecret;
  readonly redisAuthSecret?: secretsmanager.ISecret;
}

/**
 * Secrets ECS resolves at task start and injects as environment variables.
 *
 * The database credential is passed as its individual fields rather than a
 * prebuilt URL: the URL is composed by the startup script, so no assembled
 * connection string with a password in it exists in the task definition.
 */
function buildSecrets(sources: SecretSources): Record<string, ecs.Secret> {
  const secrets: Record<string, ecs.Secret> = {
    DB_HOST: ecs.Secret.fromSecretsManager(sources.databaseSecret, "host"),
    DB_PORT: ecs.Secret.fromSecretsManager(sources.databaseSecret, "port"),
    DB_USER: ecs.Secret.fromSecretsManager(sources.databaseSecret, "username"),
    DB_PASSWORD: ecs.Secret.fromSecretsManager(sources.databaseSecret, "password"),
    DB_NAME: ecs.Secret.fromSecretsManager(sources.databaseSecret, "dbname"),
    LANGFLOW_SECRET_KEY: ecs.Secret.fromSecretsManager(sources.langflowSecretKey),
  };
  if (sources.redisAuthSecret) {
    secrets.REDIS_AUTH_TOKEN = ecs.Secret.fromSecretsManager(sources.redisAuthSecret);
  }
  return secrets;
}

/**
 * Shell run as PID 1 in the container.
 *
 * ECS injects each secret as its own environment variable; the URLs Langflow
 * wants are composed here so no assembled credential is ever stored in the task
 * definition or the CloudFormation template. Every generated password excludes
 * characters that would need percent-encoding, so plain interpolation is safe.
 */
export function buildStartupScript(withRedis: boolean): string {
  const lines = [
    "set -eu",
    // Written without ${} braces on purpose: CloudFormation's template linter
    // reads "${VAR}" in a container command as an unresolved Fn::Sub reference
    // and warns on every synth. Plain "$VAR" is identical to the shell here,
    // because every expansion is terminated by a character that cannot be part
    // of a variable name.
    'export LANGFLOW_DATABASE_URL="postgresql://$DB_USER:$DB_PASSWORD@$DB_HOST:$DB_PORT/$DB_NAME"',
  ];
  if (withRedis) {
    lines.push(
      'export LANGFLOW_REDIS_URL="rediss://:$REDIS_AUTH_TOKEN@$REDIS_HOST:$REDIS_PORT/0"',
      'export LANGFLOW_RATE_LIMIT_STORAGE_URI="$LANGFLOW_REDIS_URL"',
    );
  }
  lines.push(
    // The composed URLs are what Langflow reads from here on; drop the raw
    // parts so a component that dumps the environment cannot echo them.
    "unset DB_PASSWORD",
    withRedis ? "unset REDIS_AUTH_TOKEN" : "",
    "exec langflow run",
  );
  return lines.filter(Boolean).join("\n");
}
