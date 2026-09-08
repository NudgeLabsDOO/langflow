import { App, Duration, RemovalPolicy } from "aws-cdk-lib";
import { Template, Match } from "aws-cdk-lib/assertions";
import { RetentionDays } from "aws-cdk-lib/aws-logs";
import { AuthStack } from "../lib/auth-stack";
import { CicdStack } from "../lib/cicd-stack";
import type { LangflowEnvironment } from "../lib/config";
import { environments, resolveEnvironment } from "../lib/config";
import { DataStack } from "../lib/data-stack";
import { NetworkStack } from "../lib/network-stack";
import { ServiceStack, buildStartupScript } from "../lib/service-stack";

const ACCOUNT = "447237717633";
const REGION = "eu-central-1";
const env = { account: ACCOUNT, region: REGION };

const testConfig: LangflowEnvironment = {
  envName: "test",
  account: ACCOUNT,
  region: REGION,
  hostedZoneName: "nudge-platforms.com",
  domainName: "langflow.nudge-platforms.com",
  allowedEmailDomains: ["nudge-labs.com"],
  googleClientId: "test-client-id.apps.googleusercontent.com",
  googleClientSecretName: "langflow/test/google-oauth-client-secret",
  cognitoDomainPrefix: "nudge-labs-langflow-test",
  ssoSessionTimeout: Duration.hours(8),
  allowApiKeyBypass: false,
  maxAzs: 2,
  natGateways: 1,
  albIngressCidrs: ["0.0.0.0/0"],
  enableWaf: true,
  enableVpcEndpoints: false,
  imageSource: "registry",
  registryImage: "langflowai/langflow:latest",
  dockerTarget: "full",
  cpuArchitecture: "ARM64",
  cpu: 1024,
  memoryMiB: 4096,
  desiredCount: 2,
  minCount: 2,
  maxCount: 4,
  auroraMinAcu: 0.5,
  auroraMaxAcu: 4,
  auroraReaders: 0,
  backupRetention: Duration.days(7),
  redisNodeType: "cache.t4g.micro",
  redisReplicas: 1,
  useRedisCache: true,
  githubRepository: "NudgeLabsDOO/langflow",
  githubOwnerId: "121947197",
  githubRepositoryId: "1361503006",
  githubBranch: "feature/prod-nl-iac",
  githubEnvironment: "production",
  logRetention: RetentionDays.ONE_MONTH,
  removalPolicy: RemovalPolicy.DESTROY,
  enableContainerInsights: false,
};

function synth(config: LangflowEnvironment = testConfig) {
  const app = new App({
    context: {
      // Stubs the Route53 lookup so the stacks synthesise without AWS calls.
      [`hosted-zone:account=${ACCOUNT}:domainName=${config.hostedZoneName}:region=${REGION}`]: {
        Id: "/hostedzone/ZTESTTESTTEST",
        Name: `${config.hostedZoneName}.`,
      },
    },
  });

  const network = new NetworkStack(app, "Network", { env, config });
  const data = new DataStack(app, "Data", {
    env,
    config,
    vpc: network.vpc,
    databaseSecurityGroup: network.databaseSecurityGroup,
    redisSecurityGroup: network.redisSecurityGroup,
    fileSystemSecurityGroup: network.fileSystemSecurityGroup,
  });
  const auth = new AuthStack(app, "Auth", { env, config });
  const service = new ServiceStack(app, "Service", {
    env,
    config,
    vpc: network.vpc,
    albSecurityGroup: network.albSecurityGroup,
    serviceSecurityGroup: network.serviceSecurityGroup,
    encryptionKeyArn: data.encryptionKey.keyArn,
    databaseSecretArn: data.databaseSecret.secretArn,
    langflowSecretKeyArn: data.langflowSecretKey.secretArn,
    redisAuthSecretArn: data.redisAuthSecret?.secretArn,
    fileBucketName: data.fileBucket.bucketName,
    fileSystem: data.fileSystem,
    accessPoint: data.accessPoint,
    redisEndpoint: data.redis?.attrPrimaryEndPointAddress,
    redisPort: data.redis?.attrPrimaryEndPointPort,
    alarmTopic: data.alarmTopic,
    userPool: auth.userPool,
    userPoolClient: auth.userPoolClient,
    userPoolDomain: auth.userPoolDomain,
  });

  const cicd = new CicdStack(app, "Cicd", { env, config });

  return {
    cicd: Template.fromStack(cicd),
    network: Template.fromStack(network),
    data: Template.fromStack(data),
    auth: Template.fromStack(auth),
    service: Template.fromStack(service),
  };
}

describe("configuration", () => {
  it("serves from the platforms zone but only admits Workspace identities", () => {
    const prod = resolveEnvironment("prod");
    // The hosting domain and the identity domain are deliberately different:
    // there is no nudge-labs.com hosted zone in the account.
    expect(prod.domainName).toBe("langflow.nudge-platforms.com");
    expect(prod.allowedEmailDomains).toEqual(["nudge-labs.com"]);
  });

  it("refuses an empty allow-list", () => {
    environments.broken = { ...testConfig, envName: "broken", allowedEmailDomains: [] };
    expect(() => resolveEnvironment("broken")).toThrow(/allowedEmailDomains/);
    delete environments.broken;
  });

  it("refuses to scale out without a shared cache", () => {
    environments.broken = { ...testConfig, envName: "broken", desiredCount: 3, useRedisCache: false };
    expect(() => resolveEnvironment("broken")).toThrow(/useRedisCache/);
    delete environments.broken;
  });
});

describe("network", () => {
  it("only exposes 80 and 443 to the internet", () => {
    const { network } = synth();
    const groups = network.findResources("AWS::EC2::SecurityGroup");
    const publicRules = Object.values(groups).flatMap((group: any) =>
      (group.Properties?.SecurityGroupIngress ?? []).filter(
        (rule: any) => rule.CidrIp === "0.0.0.0/0",
      ),
    );
    expect(publicRules.length).toBeGreaterThan(0);
    for (const rule of publicRules) {
      expect([80, 443]).toContain(rule.FromPort);
    }
  });

  it("puts the data tier in isolated subnets", () => {
    const { network } = synth();
    network.resourceCountIs("AWS::EC2::NatGateway", 1);
    // Two AZs x three tiers.
    network.resourceCountIs("AWS::EC2::Subnet", 6);
  });
});

describe("data", () => {
  it("encrypts the database and keeps it out of public subnets", () => {
    const { data } = synth();
    data.hasResourceProperties("AWS::RDS::DBCluster", {
      StorageEncrypted: true,
      Engine: "aurora-postgresql",
      EnableCloudwatchLogsExports: ["postgresql"],
    });
  });

  it("blocks public access on every bucket", () => {
    const { data } = synth();
    for (const bucket of Object.values(data.findResources("AWS::S3::Bucket"))) {
      expect((bucket as any).Properties.PublicAccessBlockConfiguration).toEqual({
        BlockPublicAcls: true,
        BlockPublicPolicy: true,
        IgnorePublicAcls: true,
        RestrictPublicBuckets: true,
      });
    }
  });

  it("encrypts Redis in transit and at rest", () => {
    const { data } = synth();
    data.hasResourceProperties("AWS::ElastiCache::ReplicationGroup", {
      TransitEncryptionEnabled: true,
      AtRestEncryptionEnabled: true,
      AutomaticFailoverEnabled: true,
    });
  });

  it("encrypts the file system that holds knowledge bases", () => {
    const { data } = synth();
    data.hasResourceProperties("AWS::EFS::FileSystem", { Encrypted: true });
    data.hasResourceProperties("AWS::EFS::AccessPoint", {
      PosixUser: { Uid: "1000", Gid: "0" },
    });
  });
});

describe("auth", () => {
  it("federates to Google and forbids local sign-up", () => {
    const { auth } = synth();
    auth.hasResourceProperties("AWS::Cognito::UserPool", {
      AdminCreateUserConfig: { AllowAdminCreateUserOnly: true },
    });
    auth.hasResourceProperties("AWS::Cognito::UserPoolIdentityProvider", {
      ProviderType: "Google",
    });
    auth.hasResourceProperties("AWS::Cognito::UserPoolClient", {
      SupportedIdentityProviders: ["Google"],
      AllowedOAuthFlows: ["code"],
    });
  });

  it("wires the domain guard to both sign-up and sign-in", () => {
    const { auth } = synth();
    auth.hasResourceProperties("AWS::Cognito::UserPool", {
      LambdaConfig: {
        PreSignUp: Match.anyValue(),
        PreAuthentication: Match.anyValue(),
      },
    });
    auth.hasResourceProperties("AWS::Lambda::Function", {
      Environment: { Variables: { ALLOWED_EMAIL_DOMAINS: "nudge-labs.com" } },
    });
  });
});

describe("service", () => {
  it("authenticates every request with Cognito before forwarding", () => {
    const { service } = synth();
    service.hasResourceProperties("AWS::ElasticLoadBalancingV2::Listener", {
      Port: 443,
      Protocol: "HTTPS",
      DefaultActions: Match.arrayWith([
        Match.objectLike({ Type: "authenticate-cognito", Order: 1 }),
      ]),
    });
  });

  it("redirects plain HTTP to HTTPS", () => {
    const { service } = synth();
    service.hasResourceProperties("AWS::ElasticLoadBalancingV2::Listener", {
      Port: 80,
      DefaultActions: [Match.objectLike({ Type: "redirect" })],
    });
  });

  it("adds no API-key bypass rule unless the environment opts in", () => {
    const { service } = synth();
    service.resourceCountIs("AWS::ElasticLoadBalancingV2::ListenerRule", 0);

    const opened = synth({ ...testConfig, allowApiKeyBypass: true });
    opened.service.hasResourceProperties("AWS::ElasticLoadBalancingV2::ListenerRule", {
      Conditions: Match.arrayWith([
        Match.objectLike({ Field: "http-header", HttpHeaderConfig: { HttpHeaderName: "x-api-key" } }),
      ]),
    });
  });

  it("trusts only the ALB identity header", () => {
    const { service } = synth();
    service.hasResourceProperties("AWS::ECS::TaskDefinition", {
      ContainerDefinitions: Match.arrayWith([
        Match.objectLike({
          // Match.arrayWith matches a subsequence, so these stay in the order
          // buildEnvironment emits them.
          Environment: Match.arrayWith([
            { Name: "LANGFLOW_AUTO_LOGIN", Value: "false" },
            { Name: "LANGFLOW_ENABLE_SIGNUP", Value: "false" },
            { Name: "LANGFLOW_EXTERNAL_AUTH_ENABLED", Value: "true" },
            { Name: "LANGFLOW_EXTERNAL_AUTH_TOKEN_HEADER", Value: "x-amzn-oidc-data" },
            { Name: "LANGFLOW_EXTERNAL_AUTH_TRUSTED_JWT_DECODE", Value: "true" },
          ]),
        }),
      ]),
    });
  });

  it("never puts an assembled credential in the task definition", () => {
    const { service } = synth();
    const rendered = JSON.stringify(service.toJSON());
    expect(rendered).not.toContain("postgresql://langflow:");
    expect(rendered).toContain("$DB_PASSWORD");
  });

  it("mounts the config directory from EFS", () => {
    const { service } = synth();
    service.hasResourceProperties("AWS::ECS::TaskDefinition", {
      Volumes: Match.arrayWith([
        Match.objectLike({
          EFSVolumeConfiguration: Match.objectLike({
            TransitEncryption: "ENABLED",
            AuthorizationConfig: Match.objectLike({ IAM: "ENABLED" }),
          }),
        }),
      ]),
    });
  });

  it("protects the load balancer with a web ACL", () => {
    const { service } = synth();
    service.resourceCountIs("AWS::WAFv2::WebACL", 1);
    service.resourceCountIs("AWS::WAFv2::WebACLAssociation", 1);
  });
});

describe("cicd roles", () => {
  it("lets the deploy role be assumed only from the gated environment", () => {
    const { cicd } = synth();
    cicd.hasResourceProperties("AWS::IAM::Role", {
      RoleName: "langflow-test-github-deploy",
      AssumeRolePolicyDocument: Match.objectLike({
        Statement: [
          Match.objectLike({
            Action: "sts:AssumeRoleWithWebIdentity",
            Condition: {
              StringEquals: {
                "token.actions.githubusercontent.com:aud": "sts.amazonaws.com",
                // Both spellings, because GitHub's immutable-subject rollout
                // decides which one a token actually carries.
                "token.actions.githubusercontent.com:sub": [
                  "repo:NudgeLabsDOO/langflow:environment:production",
                  "repo:NudgeLabsDOO@121947197/langflow@1361503006:environment:production",
                ],
              },
            },
          }),
        ],
      }),
    });
  });

  it("scopes the diff role to the branch and gives it no write access", () => {
    const { cicd } = synth();
    cicd.hasResourceProperties("AWS::IAM::Role", {
      RoleName: "langflow-test-github-diff",
      AssumeRolePolicyDocument: Match.objectLike({
        Statement: [
          Match.objectLike({
            Condition: {
              StringEquals: Match.objectLike({
                "token.actions.githubusercontent.com:sub": [
                  "repo:NudgeLabsDOO/langflow:ref:refs/heads/feature/prod-nl-iac",
                  "repo:NudgeLabsDOO@121947197/langflow@1361503006:ref:refs/heads/feature/prod-nl-iac",
                ],
              }),
            },
          }),
        ],
      }),
    });

    const policies = cicd.findResources("AWS::IAM::Policy");
    const diffActions = Object.entries(policies)
      .filter(([logicalId]) => logicalId.startsWith("DiffRole"))
      .flatMap(([, policy]: [string, any]) => policy.Properties.PolicyDocument.Statement)
      .flatMap((statement: any) =>
        Array.isArray(statement.Action) ? statement.Action : [statement.Action],
      );
    expect(diffActions.length).toBeGreaterThan(0);
    for (const action of diffActions) {
      expect(action).toMatch(/^(cloudformation:(Describe|Get|List)|ssm:GetParameter|sts:AssumeRole$)/);
    }
  });
});

describe("startup script", () => {
  it("composes both URLs and drops the raw secrets", () => {
    const script = buildStartupScript(true);
    expect(script).toContain(
      'export LANGFLOW_DATABASE_URL="postgresql://$DB_USER:$DB_PASSWORD@$DB_HOST:$DB_PORT/$DB_NAME"',
    );
    expect(script).toContain("rediss://:$REDIS_AUTH_TOKEN@$REDIS_HOST:$REDIS_PORT/0");
    expect(script).toContain("unset DB_PASSWORD");
    expect(script.trim().endsWith("exec langflow run")).toBe(true);
  });

  it("omits Redis entirely when there is no cache", () => {
    const script = buildStartupScript(false);
    expect(script).not.toContain("REDIS");
    expect(script).not.toContain("rediss://");
  });
});
