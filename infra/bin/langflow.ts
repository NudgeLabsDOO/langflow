#!/usr/bin/env node
import { App, Aspects, Stack, Tags } from "aws-cdk-lib";
import { AuthStack } from "../lib/auth-stack";
import { CicdStack } from "../lib/cicd-stack";
import { resolveEnvironment } from "../lib/config";
import { DataStack } from "../lib/data-stack";
import { NetworkStack } from "../lib/network-stack";
import { ServiceStack } from "../lib/service-stack";
import { SecurityChecks } from "../lib/security-checks";

const app = new App();

const envName = app.node.tryGetContext("env") ?? process.env.LANGFLOW_ENV ?? "prod";
const config = resolveEnvironment(envName);

const env = {
  account: config.account ?? process.env.CDK_DEFAULT_ACCOUNT,
  region: config.region ?? process.env.CDK_DEFAULT_REGION,
};

if (!env.account || !env.region) {
  throw new Error(
    "Account and region must be resolvable. Set LANGFLOW_AWS_ACCOUNT / LANGFLOW_AWS_REGION, " +
      "or run through a profile so CDK_DEFAULT_ACCOUNT and CDK_DEFAULT_REGION are populated. " +
      "A Route53 hosted zone lookup cannot run in an environment-agnostic stack.",
  );
}

const prefix = `Langflow-${config.envName}`;

const network = new NetworkStack(app, `${prefix}-Network`, {
  env,
  config,
  description: `Langflow ${config.envName} VPC and security groups`,
});

const data = new DataStack(app, `${prefix}-Data`, {
  env,
  config,
  vpc: network.vpc,
  databaseSecurityGroup: network.databaseSecurityGroup,
  redisSecurityGroup: network.redisSecurityGroup,
  fileSystemSecurityGroup: network.fileSystemSecurityGroup,
  description: `Langflow ${config.envName} database, object storage, file system and cache`,
});

// Deployed from a workstation, never by the pipeline it grants access to.
new CicdStack(app, `${prefix}-Cicd`, {
  env,
  config,
  description: `Langflow ${config.envName} GitHub Actions OIDC roles`,
});

const auth = new AuthStack(app, `${prefix}-Auth`, {
  env,
  config,
  description: `Langflow ${config.envName} Cognito user pool federated to Google`,
});

const service = new ServiceStack(app, `${prefix}-Service`, {
  env,
  config,
  vpc: network.vpc,
  albSecurityGroup: network.albSecurityGroup,
  serviceSecurityGroup: network.serviceSecurityGroup,

  encryptionKeyArn: data.encryptionKey.keyArn,
  databaseSecretArn: data.databaseSecret.secretArn,
  langflowSecretKeyArn: data.langflowSecretKey.secretArn,
  superuserPasswordArn: data.superuserPassword.secretArn,
  logGroupName: data.serviceLogGroup.logGroupName,
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
  description: `Langflow ${config.envName} Fargate service, load balancer and SSO gate`,
});

service.addDependency(data);
service.addDependency(auth);

for (const stack of app.node.children.filter((child): child is Stack => Stack.isStack(child))) {
  Tags.of(stack).add("Application", "langflow");
  Tags.of(stack).add("Environment", config.envName);
  Tags.of(stack).add("Owner", "nudge-labs");
  Tags.of(stack).add("ManagedBy", "aws-cdk");
}

Aspects.of(app).add(new SecurityChecks());

app.synth();
