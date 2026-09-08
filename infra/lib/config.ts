import { Duration, RemovalPolicy } from "aws-cdk-lib";
import { RetentionDays } from "aws-cdk-lib/aws-logs";

/**
 * Everything that differs between deployments of the Nudge Labs Langflow stack.
 *
 * One object per environment. `bin/langflow.ts` picks one with `-c env=<name>`
 * (default `prod`) and every stack is parameterised from it, so nothing about a
 * specific AWS account is hard-coded inside the constructs.
 */
export interface LangflowEnvironment {
  /** Short name used in stack names, resource names and tags. */
  readonly envName: string;
  /** Target account. Falls back to CDK_DEFAULT_ACCOUNT when omitted. */
  readonly account?: string;
  /** Target region. Falls back to CDK_DEFAULT_REGION when omitted. */
  readonly region?: string;

  // ---------------------------------------------------------------- DNS / TLS
  /** Public hosted zone that already exists in the target account. */
  readonly hostedZoneName: string;
  /** Fully qualified name Langflow is served on. Must sit inside the zone. */
  readonly domainName: string;

  // --------------------------------------------------------------------- SSO
  /**
   * Email domains allowed to sign in. Anything else is rejected by the Cognito
   * pre-sign-up and pre-authentication Lambda triggers before a user row exists.
   */
  readonly allowedEmailDomains: string[];
  /** Google OAuth web client id. Not a secret; safe to keep in source. */
  readonly googleClientId: string;
  /**
   * Name of the Secrets Manager secret holding the Google OAuth client secret.
   * Created out of band (see infra/README.md) so the value never enters CDK
   * source or the CloudFormation template as plaintext.
   */
  readonly googleClientSecretName: string;
  /** Optional JSON field inside that secret. Omit if the secret is the raw value. */
  readonly googleClientSecretJsonField?: string;
  /** Globally unique prefix for the Cognito hosted UI domain. */
  readonly cognitoDomainPrefix: string;
  /** How long an ALB-issued SSO session lasts before re-authentication. */
  readonly ssoSessionTimeout: Duration;
  /**
   * When true, requests carrying an `x-api-key` header skip the ALB OIDC gate so
   * machine clients (webhooks, MCP, CI) can reach the API with a Langflow API
   * key. Langflow still validates the key. Leave false to keep the deployment
   * reachable by browsers with a nudge-labs.com Google account only.
   */
  readonly allowApiKeyBypass: boolean;

  // -------------------------------------------------------------- Networking
  readonly maxAzs: number;
  readonly natGateways: number;
  /** Source CIDRs allowed to reach the ALB. Narrow this to office/VPN ranges for defence in depth. */
  readonly albIngressCidrs: string[];
  readonly enableWaf: boolean;
  /**
   * Interface endpoints for ECR / Logs / Secrets Manager / SSM, so image pulls
   * and secret reads never traverse the NAT gateway. Costs roughly $7/month per
   * endpoint per AZ (~$110/month at five endpoints across three AZs), and
   * Langflow needs internet egress for model APIs regardless, so this is off by
   * default and worth turning on only when a policy requires private endpoints.
   */
  readonly enableVpcEndpoints: boolean;

  // ----------------------------------------------------------------- Compute
  /** `build` builds this repository's Dockerfile; `registry` uses a prebuilt tag. */
  readonly imageSource: "build" | "registry";
  /** Build target from docker/build_and_push.Dockerfile. */
  readonly dockerTarget: "base" | "full" | "full-bundles";
  /** Image reference used when imageSource is `registry`. */
  readonly registryImage?: string;
  /**
   * Fargate CPU architecture. ARM64 is ~20% cheaper and the Dockerfile builds
   * natively on Apple Silicon; switch to X86_64 if a bundle dependency has no
   * aarch64 wheel, or if images are built on an x86 CI runner.
   */
  readonly cpuArchitecture: "ARM64" | "X86_64";
  readonly cpu: number;
  readonly memoryMiB: number;
  readonly desiredCount: number;
  readonly minCount: number;
  readonly maxCount: number;
  /** Extra plain (non-secret) environment variables merged into the task definition. */
  readonly extraEnvironment?: Record<string, string>;

  // -------------------------------------------------------------------- Data
  readonly auroraMinAcu: number;
  readonly auroraMaxAcu: number;
  /** Serverless v2 reader instances. 0 keeps a writer-only cluster. */
  readonly auroraReaders: number;
  readonly backupRetention: Duration;
  readonly redisNodeType: string;
  /** Read replicas in the Redis replication group. 1+ enables automatic failover. */
  readonly redisReplicas: number;
  /**
   * Redis-backed shared cache. Required whenever desiredCount > 1, because the
   * in-memory cache is per task. Langflow logs the Redis cache as experimental.
   */
  readonly useRedisCache: boolean;

  // ------------------------------------------------------------------ CI/CD
  /** `owner/repo` allowed to assume the pipeline roles. */
  readonly githubRepository: string;
  /**
   * Numeric owner and repository ids, from
   * `gh api repos/<owner>/<repo> --jq '{owner_id:.owner.id, repo_id:.id}'`.
   *
   * GitHub is migrating OIDC tokens to immutable subject claims, which splice
   * these ids into `sub`: `repo:owner@<id>/repo@<id>:ref:...` rather than
   * `repo:owner/repo:ref:...`. Which form a token carries depends on a
   * per-repository rollout flag, so the trust policies accept both.
   */
  readonly githubOwnerId: string;
  readonly githubRepositoryId: string;
  /** Branch whose pushes trigger a deployment. Scopes the read-only diff role. */
  readonly githubBranch: string;
  /**
   * GitHub Environment the deploy job runs in. The deploy role trusts only this
   * subject, so a token minted by a job that skipped the environment — and
   * therefore skipped the required reviewer — cannot assume it.
   */
  readonly githubEnvironment: string;

  // --------------------------------------------------------------------- Ops
  readonly logRetention: RetentionDays;
  /** RETAIN keeps the database, bucket and file system if the stack is deleted. */
  readonly removalPolicy: RemovalPolicy;
  /** Subscribed to the CloudWatch alarm topic when set. */
  readonly alarmEmail?: string;
  readonly enableContainerInsights: boolean;
}

/** Google Workspace domain. Identities, not hosting — no zone of this name exists in AWS. */
const WORKSPACE_EMAIL_DOMAIN = "nudge-labs.com";
/** Public Route53 zone the app is served from (Z06341873QY47D6LWX87L). */
const HOSTED_ZONE = "nudge-platforms.com";
/** Nudge Labs AWS account. */
const AWS_ACCOUNT = "447237717633";
/** Google OAuth web client federated into Cognito. Public value, not a secret. */
const GOOGLE_CLIENT_ID = "211416138739-6dkddeo28jb1t1dt7orhmh5f7f2k8qop.apps.googleusercontent.com";
/** Destination for CloudWatch alarm notifications. */
const ALARM_EMAIL = "marko.kozjak@nudge-labs.com";
/** Repository whose Actions workflows may assume the pipeline roles. */
const GITHUB_REPOSITORY = "NudgeLabsDOO/langflow";
const GITHUB_OWNER_ID = "121947197";
const GITHUB_REPOSITORY_ID = "1361503006";

export const environments: Record<string, LangflowEnvironment> = {
  prod: {
    envName: "prod",
    account: process.env.LANGFLOW_AWS_ACCOUNT ?? AWS_ACCOUNT,
    region: process.env.LANGFLOW_AWS_REGION ?? "eu-central-1",

    hostedZoneName: HOSTED_ZONE,
    domainName: `langflow.${HOSTED_ZONE}`,

    allowedEmailDomains: [WORKSPACE_EMAIL_DOMAIN],
    googleClientId: process.env.LANGFLOW_GOOGLE_CLIENT_ID ?? GOOGLE_CLIENT_ID,
    googleClientSecretName: "langflow/prod/google-oauth-client-secret",
    cognitoDomainPrefix: "nudge-labs-langflow",
    ssoSessionTimeout: Duration.hours(8),
    allowApiKeyBypass: false,

    maxAzs: 3,
    natGateways: 1,
    albIngressCidrs: ["0.0.0.0/0"],
    enableWaf: true,
    enableVpcEndpoints: false,

    imageSource: "build",
    dockerTarget: "full",
    cpuArchitecture: "ARM64",
    cpu: 2048,
    memoryMiB: 8192,
    desiredCount: 2,
    minCount: 2,
    maxCount: 6,

    auroraMinAcu: 0.5,
    auroraMaxAcu: 8,
    auroraReaders: 0,
    backupRetention: Duration.days(14),
    redisNodeType: "cache.t4g.small",
    redisReplicas: 1,
    useRedisCache: true,

    githubRepository: GITHUB_REPOSITORY,
    githubOwnerId: GITHUB_OWNER_ID,
    githubRepositoryId: GITHUB_REPOSITORY_ID,
    githubBranch: "feature/prod-nl-iac",
    githubEnvironment: "production",

    logRetention: RetentionDays.THREE_MONTHS,
    removalPolicy: RemovalPolicy.RETAIN,
    alarmEmail: process.env.LANGFLOW_ALARM_EMAIL ?? ALARM_EMAIL,
    enableContainerInsights: true,
  },

  dev: {
    envName: "dev",
    account: process.env.LANGFLOW_AWS_ACCOUNT ?? AWS_ACCOUNT,
    region: process.env.LANGFLOW_AWS_REGION ?? "eu-central-1",

    hostedZoneName: HOSTED_ZONE,
    domainName: `langflow-dev.${HOSTED_ZONE}`,

    allowedEmailDomains: [WORKSPACE_EMAIL_DOMAIN],
    googleClientId: process.env.LANGFLOW_GOOGLE_CLIENT_ID ?? GOOGLE_CLIENT_ID,
    googleClientSecretName: "langflow/dev/google-oauth-client-secret",
    cognitoDomainPrefix: "nudge-labs-langflow-dev",
    ssoSessionTimeout: Duration.hours(12),
    allowApiKeyBypass: true,

    maxAzs: 2,
    natGateways: 1,
    albIngressCidrs: ["0.0.0.0/0"],
    enableWaf: false,
    enableVpcEndpoints: false,

    imageSource: "build",
    dockerTarget: "full",
    cpuArchitecture: "ARM64",
    cpu: 1024,
    memoryMiB: 4096,
    desiredCount: 1,
    minCount: 1,
    maxCount: 2,

    auroraMinAcu: 0,
    auroraMaxAcu: 2,
    auroraReaders: 0,
    backupRetention: Duration.days(1),
    redisNodeType: "cache.t4g.micro",
    redisReplicas: 0,
    useRedisCache: false,

    githubRepository: GITHUB_REPOSITORY,
    githubOwnerId: GITHUB_OWNER_ID,
    githubRepositoryId: GITHUB_REPOSITORY_ID,
    githubBranch: "feature/dev-nl-iac",
    githubEnvironment: "development",

    logRetention: RetentionDays.TWO_WEEKS,
    removalPolicy: RemovalPolicy.DESTROY,
    alarmEmail: process.env.LANGFLOW_ALARM_EMAIL ?? ALARM_EMAIL,
    enableContainerInsights: false,
  },
};

/** Resolve the environment selected with `-c env=<name>`, validating the result. */
export function resolveEnvironment(name: string): LangflowEnvironment {
  const config = environments[name];
  if (!config) {
    const known = Object.keys(environments).join(", ");
    throw new Error(`Unknown environment "${name}". Known environments: ${known}.`);
  }

  if (!config.domainName.endsWith(config.hostedZoneName)) {
    throw new Error(
      `domainName "${config.domainName}" must sit inside hostedZoneName "${config.hostedZoneName}".`,
    );
  }
  if (config.allowedEmailDomains.length === 0) {
    throw new Error("allowedEmailDomains must list at least one domain, or anyone with a Google account can sign in.");
  }
  if (config.desiredCount > 1 && !config.useRedisCache) {
    throw new Error(
      "desiredCount > 1 requires useRedisCache: the in-memory cache is per task and flow builds would see inconsistent state.",
    );
  }
  if (config.imageSource === "registry" && !config.registryImage) {
    throw new Error('imageSource "registry" requires registryImage to be set.');
  }

  return config;
}
