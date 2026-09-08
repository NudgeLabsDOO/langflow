import { CfnOutput, Duration, RemovalPolicy, Stack, type StackProps } from "aws-cdk-lib";
import * as cloudwatch from "aws-cdk-lib/aws-cloudwatch";
import * as cwActions from "aws-cdk-lib/aws-cloudwatch-actions";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as elasticache from "aws-cdk-lib/aws-elasticache";
import * as efs from "aws-cdk-lib/aws-efs";
import * as iam from "aws-cdk-lib/aws-iam";
import * as kms from "aws-cdk-lib/aws-kms";
import * as rds from "aws-cdk-lib/aws-rds";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as secretsmanager from "aws-cdk-lib/aws-secretsmanager";
import * as sns from "aws-cdk-lib/aws-sns";
import * as snsSubs from "aws-cdk-lib/aws-sns-subscriptions";
import type { Construct } from "constructs";
import type { LangflowEnvironment } from "./config";

export interface DataStackProps extends StackProps {
  readonly config: LangflowEnvironment;
  readonly vpc: ec2.IVpc;
  /** Security groups are declared in the network stack; see the note there. */
  readonly databaseSecurityGroup: ec2.ISecurityGroup;
  readonly redisSecurityGroup: ec2.ISecurityGroup;
  readonly fileSystemSecurityGroup: ec2.ISecurityGroup;
}

/**
 * Characters excluded from every generated credential.
 *
 * Langflow takes its Postgres and Redis endpoints as URLs, and the task
 * composes those URLs with plain shell interpolation. Excluding everything that
 * would need percent-encoding keeps that composition correct without an
 * encoding step that could silently mangle a password.
 */
const URL_UNSAFE_CHARACTERS = "\"@/\\'`$&()*+,:;<=>?[]^{|}~%# !";

/**
 * Every stateful resource Langflow needs, all of it encrypted with one
 * customer-managed key and none of it reachable from the internet.
 *
 * - Aurora PostgreSQL Serverless v2 — flows, users, folders, message history
 * - S3 — uploaded and generated files (LANGFLOW_STORAGE_TYPE=s3)
 * - EFS — the Langflow config dir, which holds on-disk knowledge bases
 * - ElastiCache Redis — shared cache and rate-limit counters across tasks
 * - Secrets Manager — the Langflow secret key that encrypts global variables
 */
export class DataStack extends Stack {
  public readonly encryptionKey: kms.Key;
  public readonly database: rds.DatabaseCluster;
  public readonly databaseSecret: secretsmanager.ISecret;
  public readonly fileBucket: s3.Bucket;
  public readonly s3AccessLogBucket: s3.Bucket;
  public readonly fileSystem: efs.FileSystem;
  public readonly accessPoint: efs.AccessPoint;
  public readonly redis?: elasticache.CfnReplicationGroup;
  public readonly redisAuthSecret?: secretsmanager.Secret;
  public readonly langflowSecretKey: secretsmanager.Secret;
  public readonly alarmTopic: sns.Topic;

  constructor(scope: Construct, id: string, props: DataStackProps) {
    super(scope, id, props);
    const { config, vpc, databaseSecurityGroup, redisSecurityGroup, fileSystemSecurityGroup } = props;
    const isRetained = config.removalPolicy === RemovalPolicy.RETAIN;

    this.alarmTopic = new sns.Topic(this, "AlarmTopic", {
      topicName: `langflow-${config.envName}-alarms`,
      displayName: `Langflow ${config.envName} alarms`,
      enforceSSL: true,
    });
    if (config.alarmEmail) {
      this.alarmTopic.addSubscription(new snsSubs.EmailSubscription(config.alarmEmail));
    }

    this.encryptionKey = new kms.Key(this, "EncryptionKey", {
      alias: `alias/langflow-${config.envName}`,
      description: `Encryption at rest for the Langflow ${config.envName} deployment`,
      enableKeyRotation: true,
      removalPolicy: config.removalPolicy,
      pendingWindow: Duration.days(isRetained ? 30 : 7),
    });

    // The service stack imports this key by ARN so its IAM grants stay
    // principal-side — a resource-policy grant written from that stack would
    // make this stack depend on it and close a dependency cycle. Everything the
    // key policy needs beyond the account root therefore has to be stated here.
    this.encryptionKey.addToResourcePolicy(
      new iam.PolicyStatement({
        sid: "AllowCloudWatchLogs",
        principals: [new iam.ServicePrincipal(`logs.${this.region}.amazonaws.com`)],
        actions: ["kms:Encrypt*", "kms:Decrypt*", "kms:ReEncrypt*", "kms:GenerateDataKey*", "kms:Describe*"],
        resources: ["*"],
        conditions: {
          ArnLike: {
            "kms:EncryptionContext:aws:logs:arn": `arn:aws:logs:${this.region}:${this.account}:log-group:*`,
          },
        },
      }),
    );

    // ------------------------------------------------------------- Secret key
    // Encrypts global variables and API keys at rest. Changing it makes every
    // stored credential undecryptable, so it is generated once and retained
    // even when the rest of the environment is torn down.
    this.langflowSecretKey = new secretsmanager.Secret(this, "LangflowSecretKey", {
      secretName: `langflow/${config.envName}/secret-key`,
      description: "LANGFLOW_SECRET_KEY — never rotate, it decrypts stored global variables",
      encryptionKey: this.encryptionKey,
      generateSecretString: {
        passwordLength: 64,
        excludePunctuation: true,
        includeSpace: false,
      },
      removalPolicy: RemovalPolicy.RETAIN,
    });

    // --------------------------------------------------------------- Postgres
    this.database = new rds.DatabaseCluster(this, "Database", {
      clusterIdentifier: `langflow-${config.envName}`,
      engine: rds.DatabaseClusterEngine.auroraPostgres({
        version: rds.AuroraPostgresEngineVersion.VER_16_6,
      }),
      vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
      securityGroups: [databaseSecurityGroup],
      defaultDatabaseName: "langflow",
      credentials: rds.Credentials.fromGeneratedSecret("langflow", {
        secretName: `langflow/${config.envName}/database`,
        encryptionKey: this.encryptionKey,
        excludeCharacters: URL_UNSAFE_CHARACTERS,
      }),
      writer: rds.ClusterInstance.serverlessV2("writer", {
        enablePerformanceInsights: true,
        performanceInsightEncryptionKey: this.encryptionKey,
        performanceInsightRetention: rds.PerformanceInsightRetention.DEFAULT,
      }),
      readers: Array.from({ length: config.auroraReaders }, (_, index) =>
        rds.ClusterInstance.serverlessV2(`reader${index + 1}`, { scaleWithWriter: true }),
      ),
      serverlessV2MinCapacity: config.auroraMinAcu,
      serverlessV2MaxCapacity: config.auroraMaxAcu,
      storageEncrypted: true,
      storageEncryptionKey: this.encryptionKey,
      backup: {
        retention: config.backupRetention,
        preferredWindow: "02:00-03:00",
      },
      preferredMaintenanceWindow: "Sun:03:30-Sun:04:30",
      cloudwatchLogsExports: ["postgresql"],
      cloudwatchLogsRetention: config.logRetention,
      deletionProtection: isRetained,
      removalPolicy: config.removalPolicy,
      copyTagsToSnapshot: true,
    });
    this.databaseSecret = this.database.secret!;

    // Automatic rotation is deliberately not enabled. ECS resolves secrets once,
    // when a task starts, so a rotated master password would leave every running
    // task holding a credential the cluster no longer accepts until the service
    // is redeployed. Rotate manually and follow it with a forced new deployment
    // (see infra/README.md).

    // ----------------------------------------------------------------- Files
    this.s3AccessLogBucket = new s3.Bucket(this, "AccessLogBucket", {
      bucketName: `langflow-${config.envName}-s3-access-logs-${this.account}`,
      encryption: s3.BucketEncryption.S3_MANAGED, // Log delivery cannot use a CMK
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      versioned: false,
      lifecycleRules: [{ id: "expire", expiration: Duration.days(90) }],
      removalPolicy: config.removalPolicy,
      autoDeleteObjects: !isRetained,
    });

    this.fileBucket = new s3.Bucket(this, "FileBucket", {
      bucketName: `langflow-${config.envName}-files-${this.account}`,
      encryption: s3.BucketEncryption.KMS,
      encryptionKey: this.encryptionKey,
      bucketKeyEnabled: true,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      versioned: true,
      serverAccessLogsBucket: this.s3AccessLogBucket,
      serverAccessLogsPrefix: "s3/files/",
      lifecycleRules: [
        { id: "abort-incomplete-uploads", abortIncompleteMultipartUploadAfter: Duration.days(7) },
        { id: "expire-old-versions", noncurrentVersionExpiration: Duration.days(90) },
      ],
      removalPolicy: config.removalPolicy,
      autoDeleteObjects: !isRetained,
    });

    // ------------------------------------------------------------------- EFS
    // Langflow writes on-disk knowledge bases, caches and component metadata
    // under LANGFLOW_CONFIG_DIR. Fargate task storage is ephemeral, so that
    // directory lives on EFS and survives task replacement and redeploys.
    this.fileSystem = new efs.FileSystem(this, "FileSystem", {
      fileSystemName: `langflow-${config.envName}`,
      vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
      securityGroup: fileSystemSecurityGroup,
      encrypted: true,
      kmsKey: this.encryptionKey,
      performanceMode: efs.PerformanceMode.GENERAL_PURPOSE,
      throughputMode: efs.ThroughputMode.ELASTIC,
      lifecyclePolicy: efs.LifecyclePolicy.AFTER_30_DAYS,
      outOfInfrequentAccessPolicy: efs.OutOfInfrequentAccessPolicy.AFTER_1_ACCESS,
      enableAutomaticBackups: isRetained,
      removalPolicy: config.removalPolicy,
    });

    // uid 1000 / gid 0 matches the `user` account in docker/build_and_push.Dockerfile.
    this.accessPoint = this.fileSystem.addAccessPoint("ConfigAccessPoint", {
      path: "/langflow",
      createAcl: { ownerUid: "1000", ownerGid: "0", permissions: "0775" },
      posixUser: { uid: "1000", gid: "0" },
    });

    // ----------------------------------------------------------------- Redis
    if (config.useRedisCache) {
      this.redisAuthSecret = new secretsmanager.Secret(this, "RedisAuthToken", {
        secretName: `langflow/${config.envName}/redis-auth-token`,
        description: "ElastiCache AUTH token for the Langflow Redis replication group",
        encryptionKey: this.encryptionKey,
        generateSecretString: {
          passwordLength: 64,
          excludeCharacters: URL_UNSAFE_CHARACTERS,
          includeSpace: false,
        },
        removalPolicy: config.removalPolicy,
      });

      const subnetGroup = new elasticache.CfnSubnetGroup(this, "RedisSubnetGroup", {
        cacheSubnetGroupName: `langflow-${config.envName}`,
        description: `Langflow ${config.envName} Redis subnets`,
        subnetIds: vpc.selectSubnets({ subnetType: ec2.SubnetType.PRIVATE_ISOLATED }).subnetIds,
      });

      const multiAz = config.redisReplicas > 0;
      this.redis = new elasticache.CfnReplicationGroup(this, "Redis", {
        replicationGroupId: `langflow-${config.envName}`,
        replicationGroupDescription: `Langflow ${config.envName} cache`,
        engine: "redis",
        engineVersion: "7.1",
        cacheParameterGroupName: "default.redis7",
        cacheNodeType: config.redisNodeType,
        numNodeGroups: 1,
        replicasPerNodeGroup: config.redisReplicas,
        automaticFailoverEnabled: multiAz,
        multiAzEnabled: multiAz,
        cacheSubnetGroupName: subnetGroup.cacheSubnetGroupName,
        securityGroupIds: [redisSecurityGroup.securityGroupId],
        atRestEncryptionEnabled: true,
        kmsKeyId: this.encryptionKey.keyId,
        transitEncryptionEnabled: true,
        authToken: this.redisAuthSecret.secretValue.unsafeUnwrap(),
        snapshotRetentionLimit: isRetained ? 7 : 1,
        preferredMaintenanceWindow: "sun:05:00-sun:06:00",
        autoMinorVersionUpgrade: true,
      });
      this.redis.addDependency(subnetGroup);
      this.redis.applyRemovalPolicy(config.removalPolicy);
    }

    this.addDataAlarms(config);

    new CfnOutput(this, "DatabaseEndpoint", { value: this.database.clusterEndpoint.hostname });
    new CfnOutput(this, "DatabaseSecretArn", { value: this.databaseSecret.secretArn });
    new CfnOutput(this, "FileBucketName", { value: this.fileBucket.bucketName });
    new CfnOutput(this, "FileSystemId", { value: this.fileSystem.fileSystemId });
    if (this.redis) {
      new CfnOutput(this, "RedisPrimaryEndpoint", {
        value: this.redis.attrPrimaryEndPointAddress,
      });
    }
  }

  private addDataAlarms(config: LangflowEnvironment): void {
    const action = new cwActions.SnsAction(this.alarmTopic);

    const cpu = this.database
      .metricCPUUtilization({ period: Duration.minutes(5) })
      .createAlarm(this, "DatabaseCpuAlarm", {
        alarmName: `langflow-${config.envName}-db-cpu`,
        threshold: 85,
        evaluationPeriods: 3,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      });
    cpu.addAlarmAction(action);

    const connections = this.database
      .metricDatabaseConnections({ period: Duration.minutes(5) })
      .createAlarm(this, "DatabaseConnectionsAlarm", {
        alarmName: `langflow-${config.envName}-db-connections`,
        threshold: 180,
        evaluationPeriods: 3,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      });
    connections.addAlarmAction(action);

    const freeableMemory = new cloudwatch.Alarm(this, "DatabaseMemoryAlarm", {
      alarmName: `langflow-${config.envName}-db-freeable-memory`,
      metric: this.database.metric("FreeableMemory", { period: Duration.minutes(5) }),
      threshold: 256 * 1024 * 1024,
      comparisonOperator: cloudwatch.ComparisonOperator.LESS_THAN_THRESHOLD,
      evaluationPeriods: 3,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });
    freeableMemory.addAlarmAction(action);
  }
}
