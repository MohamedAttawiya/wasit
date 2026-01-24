// infra/lib/auth/AuthControlPlaneStack.ts

import * as path from "path";
import * as cdk from "aws-cdk-lib";
import { Construct } from "constructs";
import * as cognito from "aws-cdk-lib/aws-cognito";
import * as ddb from "aws-cdk-lib/aws-dynamodb";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as apigwv2 from "aws-cdk-lib/aws-apigatewayv2";
import * as apigwv2Integrations from "aws-cdk-lib/aws-apigatewayv2-integrations";
import * as secretsmanager from "aws-cdk-lib/aws-secretsmanager";
import { NodejsFunction, OutputFormat } from "aws-cdk-lib/aws-lambda-nodejs";

export interface AuthControlPlaneStackProps extends cdk.StackProps {
  prefix: string;
  corsAllowOrigins?: string[];

  googleSecretName: string;
  createGoogleSecretIfMissing: boolean;
  enableGoogleIdp?: boolean;

  callbackUrls: string[];
  logoutUrls: string[];

  usersStateTableName?: string;        // default users_state
  authzGrantsTableName?: string;       // default authz_grants
  authzCapabilitiesTableName?: string; // default authz_capabilities

  cognitoDomainPrefix?: string;
}

export class AuthControlPlaneStack extends cdk.Stack {
  public readonly userPool: cognito.UserPool;
  public readonly webClient: cognito.UserPoolClient;

  public readonly usersStateTable: ddb.Table;
  public readonly authzGrantsTable: ddb.Table;
  public readonly authzCapabilitiesTable: ddb.Table;

  public readonly controlPlaneFn: lambda.IFunction;
  public readonly httpApi: apigwv2.HttpApi;

  public readonly issuer: string;
  public readonly cognitoHostedDomain: string;
  public readonly googleRedirectUri: string;

  constructor(scope: Construct, id: string, props: AuthControlPlaneStackProps) {
    super(scope, id, props);

    const prefix = props.prefix;
    const enableGoogleIdp = props.enableGoogleIdp ?? false;

    // ----------------------------
    // Google OAuth Secret
    // ----------------------------
    const googleSecret = props.createGoogleSecretIfMissing
      ? new secretsmanager.Secret(this, "GoogleOAuthSecret", {
          secretName: props.googleSecretName,
          secretObjectValue: {
            clientId: cdk.SecretValue.unsafePlainText("REPLACE_ME"),
            clientSecret: cdk.SecretValue.unsafePlainText("REPLACE_ME"),
          },
          removalPolicy: cdk.RemovalPolicy.RETAIN,
        })
      : secretsmanager.Secret.fromSecretNameV2(
          this,
          "GoogleOAuthSecretImported",
          props.googleSecretName
        );

    // ----------------------------
    // Cognito User Pool
    // ----------------------------
    this.userPool = new cognito.UserPool(this, "UserPool", {
      userPoolName: `${prefix}-users`,
      signInAliases: { email: true },
      selfSignUpEnabled: true,
      standardAttributes: {
        email: { required: true, mutable: true },
        fullname: { required: false, mutable: true },
      },
      passwordPolicy: {
        minLength: 12,
        requireDigits: true,
        requireLowercase: true,
        requireUppercase: true,
        requireSymbols: true,
      },
      accountRecovery: cognito.AccountRecovery.EMAIL_ONLY,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    // ----------------------------
    // Hosted UI Domain
    // ----------------------------
    const domainPrefix = props.cognitoDomainPrefix ?? `${prefix}-auth`;

    const domain = this.userPool.addDomain("HostedDomain", {
      cognitoDomain: { domainPrefix },
    });

    this.cognitoHostedDomain = `${domainPrefix}.auth.${this.region}.amazoncognito.com`;
    this.googleRedirectUri = `https://${this.cognitoHostedDomain}/oauth2/idpresponse`;

    this.issuer = `https://cognito-idp.${this.region}.amazonaws.com/${this.userPool.userPoolId}`;

    // ----------------------------
    // Optional Google IdP
    // ----------------------------
    if (enableGoogleIdp) {
      new cognito.CfnUserPoolIdentityProvider(this, "GoogleProvider", {
        providerName: "Google",
        providerType: "Google",
        userPoolId: this.userPool.userPoolId,
        providerDetails: {
          client_id: googleSecret.secretValueFromJson("clientId").unsafeUnwrap(),
          client_secret: googleSecret.secretValueFromJson("clientSecret").unsafeUnwrap(),
          authorize_scopes: "profile email",
        },
        attributeMapping: {
          email: "email",
          name: "name",
          email_verified: "email_verified",
        },
      });
    }

    // ----------------------------
    // OAuth Client
    // ----------------------------
    this.webClient = new cognito.UserPoolClient(this, "WebClient", {
      userPool: this.userPool,
      generateSecret: false,
      oAuth: {
        flows: {
          authorizationCodeGrant: true,
          implicitCodeGrant: true,
        },
        scopes: [
          cognito.OAuthScope.OPENID,
          cognito.OAuthScope.EMAIL,
          cognito.OAuthScope.PROFILE,
        ],
        callbackUrls: props.callbackUrls,
        logoutUrls: props.logoutUrls,
      },
      supportedIdentityProviders: enableGoogleIdp
        ? [
            cognito.UserPoolClientIdentityProvider.COGNITO,
            cognito.UserPoolClientIdentityProvider.GOOGLE,
          ]
        : [cognito.UserPoolClientIdentityProvider.COGNITO],
    });

    // ----------------------------
    // DynamoDB Tables
    // ----------------------------
    this.usersStateTable = new ddb.Table(this, "UsersStateTable", {
      tableName: props.usersStateTableName ?? "users_state",
      partitionKey: { name: "pk", type: ddb.AttributeType.STRING },
      billingMode: ddb.BillingMode.PAY_PER_REQUEST,
      pointInTimeRecovery: true,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    this.authzGrantsTable = new ddb.Table(this, "AuthzGrantsTable", {
      tableName: props.authzGrantsTableName ?? "authz_grants",
      partitionKey: { name: "pk", type: ddb.AttributeType.STRING },
      sortKey: { name: "sk", type: ddb.AttributeType.STRING },
      billingMode: ddb.BillingMode.PAY_PER_REQUEST,
      pointInTimeRecovery: true,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    this.authzCapabilitiesTable = new ddb.Table(this, "AuthzCapabilitiesTable", {
      tableName: props.authzCapabilitiesTableName ?? "authz_capabilities",
      partitionKey: { name: "pk", type: ddb.AttributeType.STRING }, // GROUP#<name>
      billingMode: ddb.BillingMode.PAY_PER_REQUEST,
      pointInTimeRecovery: true,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    // ----------------------------
    // Auth Resolver Lambda (GET /me only)
    // - No Cognito calls
    // - No authorizers at API Gateway
    // - @wasit/authz verifies JWT from headers
    // ----------------------------
    this.controlPlaneFn = new NodejsFunction(this, "AuthControlPlaneFn", {
      runtime: lambda.Runtime.NODEJS_20_X,
      entry: path.join(__dirname, "../../lambda/auth/index.js"), // adjust to .js if you kept JS
      handler: "handler",
      timeout: cdk.Duration.seconds(15),
      memorySize: 256,
      environment: {
        // For @wasit/authz verification (reads these from env)
        USER_POOL_ID: this.userPool.userPoolId,
        CLIENT_ID: this.webClient.userPoolClientId,

        // For resolution
        USERS_STATE_TABLE: this.usersStateTable.tableName,
        AUTHZ_GRANTS_TABLE: this.authzGrantsTable.tableName,
        AUTHZ_CAPABILITIES_TABLE: this.authzCapabilitiesTable.tableName,
      },
      bundling: {
        format: OutputFormat.ESM,
        target: "node20",
        sourceMap: true,
      },
    });

    // Least privilege: resolver should be read-only
    this.usersStateTable.grantReadData(this.controlPlaneFn);
    this.authzGrantsTable.grantReadData(this.controlPlaneFn);
    this.authzCapabilitiesTable.grantReadData(this.controlPlaneFn);

    // ----------------------------
    // HTTP API (single route: GET /me)
    // ----------------------------
    this.httpApi = new apigwv2.HttpApi(this, "AuthControlPlaneHttpApi", {
      apiName: `${prefix}-auth-control-plane`,
      corsPreflight: {
        allowHeaders: ["authorization", "content-type", "x-correlation-id"],
        allowMethods: [apigwv2.CorsHttpMethod.GET],
        allowOrigins: props.corsAllowOrigins ?? ["http://localhost:3000"],
      },
    });

    const integration = new apigwv2Integrations.HttpLambdaIntegration(
      "AuthControlPlaneIntegration",
      this.controlPlaneFn
    );

    // Single endpoint
    this.httpApi.addRoutes({
      path: "/me",
      methods: [apigwv2.HttpMethod.GET],
      integration,
    });

    // Optional: helpful outputs
    new cdk.CfnOutput(this, "AuthApiBaseUrl", { value: this.httpApi.url ?? "" });
    new cdk.CfnOutput(this, "CognitoIssuer", { value: this.issuer });
    new cdk.CfnOutput(this, "UserPoolId", { value: this.userPool.userPoolId });
    new cdk.CfnOutput(this, "WebClientId", { value: this.webClient.userPoolClientId });
  }
}
