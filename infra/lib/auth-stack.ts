import { CfnOutput, Duration, RemovalPolicy, SecretValue, Stack, type StackProps } from "aws-cdk-lib";
import * as cognito from "aws-cdk-lib/aws-cognito";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as logs from "aws-cdk-lib/aws-logs";
import * as path from "node:path";
import type { Construct } from "constructs";
import type { LangflowEnvironment } from "./config";

export interface AuthStackProps extends StackProps {
  readonly config: LangflowEnvironment;
}

/**
 * The identity layer that sits in front of Langflow.
 *
 * Google is the only sign-in method, Cognito is the OIDC provider the load
 * balancer talks to, and a Lambda trigger rejects any identity whose email is
 * outside the allowed domains — before a user pool record exists and therefore
 * long before a request reaches the application.
 *
 * The user pool never receives a password: local sign-up is disabled and the
 * app client only advertises Google.
 */
export class AuthStack extends Stack {
  public readonly userPool: cognito.UserPool;
  public readonly userPoolClient: cognito.UserPoolClient;
  public readonly userPoolDomain: cognito.UserPoolDomain;
  /** Issuer URL of the pool, used for Langflow's external-identity settings. */
  public readonly issuerUrl: string;

  constructor(scope: Construct, id: string, props: AuthStackProps) {
    super(scope, id, props);
    const { config } = props;

    if (!config.googleClientId) {
      throw new Error(
        "googleClientId is empty. Set LANGFLOW_GOOGLE_CLIENT_ID or edit infra/lib/config.ts — " +
          "without it Cognito cannot federate to Google.",
      );
    }

    const domainGuard = new lambda.Function(this, "DomainGuard", {
      functionName: `langflow-${config.envName}-domain-guard`,
      description: `Restrict Langflow sign-in to ${config.allowedEmailDomains.join(", ")}`,
      runtime: lambda.Runtime.NODEJS_22_X,
      handler: "index.handler",
      code: lambda.Code.fromAsset(path.join(__dirname, "..", "lambda", "domain-guard")),
      timeout: Duration.seconds(10),
      memorySize: 128,
      environment: {
        ALLOWED_EMAIL_DOMAINS: config.allowedEmailDomains.join(","),
      },
      logGroup: new logs.LogGroup(this, "DomainGuardLogs", {
        logGroupName: `/aws/lambda/langflow-${config.envName}-domain-guard`,
        retention: config.logRetention,
        removalPolicy: RemovalPolicy.DESTROY,
      }),
    });

    this.userPool = new cognito.UserPool(this, "UserPool", {
      userPoolName: `langflow-${config.envName}`,
      // Every account arrives through Google. Nothing may register directly.
      selfSignUpEnabled: false,
      signInAliases: { email: true },
      signInCaseSensitive: false,
      standardAttributes: {
        email: { required: true, mutable: true },
        givenName: { required: false, mutable: true },
        familyName: { required: false, mutable: true },
      },
      autoVerify: { email: true },
      accountRecovery: cognito.AccountRecovery.NONE,
      mfa: cognito.Mfa.OFF, // Enforced by Google Workspace, not here.
      featurePlan: cognito.FeaturePlan.LITE,
      deletionProtection: config.removalPolicy === RemovalPolicy.RETAIN,
      removalPolicy: config.removalPolicy,
      lambdaTriggers: {
        preSignUp: domainGuard,
        preAuthentication: domainGuard,
      },
    });

    const googleProvider = new cognito.UserPoolIdentityProviderGoogle(this, "Google", {
      userPool: this.userPool,
      clientId: config.googleClientId,
      clientSecretValue: SecretValue.secretsManager(
        config.googleClientSecretName,
        config.googleClientSecretJsonField
          ? { jsonField: config.googleClientSecretJsonField }
          : undefined,
      ),
      scopes: ["openid", "email", "profile"],
      attributeMapping: {
        email: cognito.ProviderAttribute.GOOGLE_EMAIL,
        emailVerified: cognito.ProviderAttribute.GOOGLE_EMAIL_VERIFIED,
        givenName: cognito.ProviderAttribute.GOOGLE_GIVEN_NAME,
        familyName: cognito.ProviderAttribute.GOOGLE_FAMILY_NAME,
        fullname: cognito.ProviderAttribute.GOOGLE_NAME,
        profilePicture: cognito.ProviderAttribute.GOOGLE_PICTURE,
      },
    });

    this.userPoolDomain = this.userPool.addDomain("HostedUiDomain", {
      cognitoDomain: { domainPrefix: config.cognitoDomainPrefix },
    });

    const callbackUrl = `https://${config.domainName}/oauth2/idpresponse`;
    this.userPoolClient = this.userPool.addClient("AlbClient", {
      userPoolClientName: `langflow-${config.envName}-alb`,
      // The ALB authenticate-cognito action performs a confidential-client
      // authorization code exchange, so the client must have a secret.
      generateSecret: true,
      supportedIdentityProviders: [cognito.UserPoolClientIdentityProvider.GOOGLE],
      oAuth: {
        flows: { authorizationCodeGrant: true },
        scopes: [cognito.OAuthScope.OPENID, cognito.OAuthScope.EMAIL, cognito.OAuthScope.PROFILE],
        callbackUrls: [callbackUrl],
        logoutUrls: [`https://${config.domainName}/`],
      },
      authFlows: {}, // No direct auth: the hosted UI plus Google only.
      preventUserExistenceErrors: true,
      accessTokenValidity: Duration.hours(1),
      idTokenValidity: Duration.hours(1),
      refreshTokenValidity: Duration.days(7),
      enableTokenRevocation: true,
    });
    // Cognito rejects a client that lists a provider the pool does not have yet.
    this.userPoolClient.node.addDependency(googleProvider);

    this.issuerUrl = `https://cognito-idp.${this.region}.amazonaws.com/${this.userPool.userPoolId}`;

    new CfnOutput(this, "UserPoolId", { value: this.userPool.userPoolId });
    new CfnOutput(this, "UserPoolClientId", { value: this.userPoolClient.userPoolClientId });
    new CfnOutput(this, "HostedUiDomain", { value: this.userPoolDomain.domainName });
    new CfnOutput(this, "GoogleRedirectUri", {
      value: `https://${config.cognitoDomainPrefix}.auth.${this.region}.amazoncognito.com/oauth2/idpresponse`,
      description: "Add this as an Authorized redirect URI on the Google OAuth client",
    });
    new CfnOutput(this, "AlbCallbackUrl", { value: callbackUrl });
  }
}
