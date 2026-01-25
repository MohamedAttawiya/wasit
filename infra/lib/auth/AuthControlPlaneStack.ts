// infra/lib/auth/AuthControlPlaneStack.ts
import * as path from "path";
import * as cdk from "aws-cdk-lib";
import { Construct } from "constructs";

import * as acm from "aws-cdk-lib/aws-certificatemanager";
import * as cognito from "aws-cdk-lib/aws-cognito";
import * as ddb from "aws-cdk-lib/aws-dynamodb";
import * as lambda from "aws-cdk-lib/aws-lambda";
import { NodejsFunction, OutputFormat } from "aws-cdk-lib/aws-lambda-nodejs";
import * as apigwv2 from "aws-cdk-lib/aws-apigatewayv2";
import * as apigwv2Integrations from "aws-cdk-lib/aws-apigatewayv2-integrations";
import * as route53 from "aws-cdk-lib/aws-route53";

export interface AuthControlPlaneStackProps extends cdk.StackProps {
  prefix: string;
  stage: string;

  // Domain inputs (infra passes these)
  authSubdomain: string; // "auth"
  platformHostedZoneId: string;
  platformRootDomain: string; // "wasit-platform.shop"

  /**
   * REQUIRED:
   * Cognito UserPool custom-domain certificate MUST be in us-east-1
   * because Cognito custom domains are CloudFront-backed.
   *
   * This should be a cert for auth.<platformRootDomain>, created in us-east-1.
   */
  platformAuthCertArnUsEast1: string;

  /**
   * OPTIONAL: Wildcard cert in us-east-1 for future CloudFront usage only.
   * Not used by Cognito UserPoolDomain (unless you intentionally use it for auth host).
   */
  platformWildcardCertArnUsEast1?: string;

  // Browser CORS + OAuth
  corsAllowOrigins?: string[];
  callbackUrls?: string[];
  logoutUrls?: string[];

  // Optional table name overrides
  usersStateTableName?: string; // default: users_state
  authzCapabilitiesTableName?: string; // default: authz_capabilities
  authzGrantsTableName?: string; // default: authz_grants
}

export class AuthControlPlaneStack extends cdk.Stack {
  public readonly userPool: cognito.UserPool;
  public readonly webClient: cognito.UserPoolClient;
  public readonly cognitoDomain: cognito.UserPoolDomain;

  public readonly usersStateTable: ddb.Table;
  public readonly authzCapabilitiesTable: ddb.Table;
  public readonly authzGrantsTable: ddb.Table;

  public readonly authReadFn: lambda.IFunction;
  public readonly authAdminFn: lambda.IFunction;

  public readonly authReadFnArn: string;
  public readonly authAdminFnArn: string;

  public readonly httpApi: apigwv2.HttpApi;
  public readonly httpApiUrl: string;

  public readonly issuer: string;

  constructor(scope: Construct, id: string, props: AuthControlPlaneStackProps) {
    super(scope, id, props);

    const prefix = props.prefix;
    const authHost = `${props.authSubdomain}.${props.platformRootDomain}`;

    // ----------------------------
    // Hosted Zone (import) - zone lives wherever, Route53 is global
    // ----------------------------
    const platformZone = route53.HostedZone.fromHostedZoneAttributes(this, "PlatformZone", {
      hostedZoneId: props.platformHostedZoneId,
      zoneName: props.platformRootDomain,
    });

    // ----------------------------
    // Cognito User Pool (regional - this stack's region, e.g. eu-central-1)
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

    this.issuer = `https://cognito-idp.${this.region}.amazonaws.com/${this.userPool.userPoolId}`;

    // ----------------------------
    // Cognito Custom Domain (auth.<platformRoot>)
    // IMPORTANT: certificate MUST be in us-east-1
    // ----------------------------
    const authCertUsEast1 = acm.Certificate.fromCertificateArn(
      this,
      "AuthCertUsEast1",
      props.platformAuthCertArnUsEast1
    );

    this.cognitoDomain = this.userPool.addDomain("AuthCustomDomain", {
      customDomain: {
        domainName: authHost,
        certificate: authCertUsEast1,
      },
    });

    // ----------------------------
    // DNS record: auth.<root> -> Cognito's CloudFront endpoint
    // ----------------------------
    new route53.CnameRecord(this, "AuthDomainCname", {
      zone: platformZone,
      recordName: props.authSubdomain, // "auth"
      domainName: this.cognitoDomain.cloudFrontEndpoint,
      ttl: cdk.Duration.minutes(5),
    });

    // ----------------------------
    // User Pool Client (OAuth)
    // ----------------------------
    const defaultCallbackUrls = [
      "http://localhost:5173/callback",
      "http://localhost:3000/callback",
      "https://admin.wasit-platform.shop/callback",
      "https://internal.wasit-platform.shop/callback",
    ];

    const defaultLogoutUrls = [
      "http://localhost:5173",
      "http://localhost:3000",
      "https://admin.wasit-platform.shop",
      "https://internal.wasit-platform.shop",
    ];

    this.webClient = new cognito.UserPoolClient(this, "WebClient", {
      userPool: this.userPool,
      generateSecret: false,
      oAuth: {
        flows: { authorizationCodeGrant: true },
        scopes: [cognito.OAuthScope.OPENID, cognito.OAuthScope.EMAIL, cognito.OAuthScope.PROFILE],
        callbackUrls: props.callbackUrls ?? defaultCallbackUrls,
        logoutUrls: props.logoutUrls ?? defaultLogoutUrls,
      },
      supportedIdentityProviders: [cognito.UserPoolClientIdentityProvider.COGNITO],
    });

    // ----------------------------
    // Tables (owned by Auth)
    // ----------------------------
    this.usersStateTable = new ddb.Table(this, "UsersStateTable", {
      tableName: props.usersStateTableName ?? "users_state",
      partitionKey: { name: "pk", type: ddb.AttributeType.STRING },
      billingMode: ddb.BillingMode.PAY_PER_REQUEST,
      pointInTimeRecovery: true,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    this.authzCapabilitiesTable = new ddb.Table(this, "AuthzCapabilitiesTable", {
      tableName: props.authzCapabilitiesTableName ?? "authz_capabilities",
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

    const commonEnv = {
      USER_POOL_ID: this.userPool.userPoolId,
      CLIENT_ID: this.webClient.userPoolClientId,
      USERS_STATE_TABLE: this.usersStateTable.tableName,
      AUTHZ_CAPABILITIES_TABLE: this.authzCapabilitiesTable.tableName,
      AUTHZ_GRANTS_TABLE: this.authzGrantsTable.tableName,
    };

    // ----------------------------
    // Lambdas
    // ----------------------------
    this.authReadFn = new NodejsFunction(this, "AuthReadFn", {
      runtime: lambda.Runtime.NODEJS_20_X,
      entry: path.join(__dirname, "../../lambda/auth/index.js"),
      handler: "handler",
      timeout: cdk.Duration.seconds(15),
      memorySize: 256,
      environment: commonEnv,
      bundling: { format: OutputFormat.ESM, target: "node20", sourceMap: true },
    });

    this.authAdminFn = new NodejsFunction(this, "AuthAdminFn", {
      runtime: lambda.Runtime.NODEJS_20_X,
      entry: path.join(__dirname, "../../lambda/auth/admin.js"),
      handler: "handler",
      timeout: cdk.Duration.seconds(15),
      memorySize: 256,
      environment: commonEnv,
      bundling: { format: OutputFormat.ESM, target: "node20", sourceMap: true },
    });

    this.usersStateTable.grantReadData(this.authReadFn);
    this.authzCapabilitiesTable.grantReadData(this.authReadFn);
    this.authzGrantsTable.grantReadData(this.authReadFn);

    this.usersStateTable.grantReadWriteData(this.authAdminFn);
    this.authzCapabilitiesTable.grantReadWriteData(this.authAdminFn);
    this.authzGrantsTable.grantReadWriteData(this.authAdminFn);

    this.authReadFnArn = this.authReadFn.functionArn;
    this.authAdminFnArn = this.authAdminFn.functionArn;

    // ----------------------------
    // HTTP API (owned by Auth)
    // ----------------------------
    const defaultCors = [
      "http://localhost:3000",
      "http://localhost:5173",
      "https://admin.wasit-platform.shop",
      "https://internal.wasit-platform.shop",
    ];

    this.httpApi = new apigwv2.HttpApi(this, "AuthHttpApi", {
      apiName: `${prefix}-auth-api`,
      corsPreflight: {
        allowHeaders: ["authorization", "content-type", "x-correlation-id"],
        allowMethods: [
          apigwv2.CorsHttpMethod.GET,
          apigwv2.CorsHttpMethod.POST,
          apigwv2.CorsHttpMethod.PUT,
          apigwv2.CorsHttpMethod.DELETE,
          apigwv2.CorsHttpMethod.OPTIONS,
        ],
        allowOrigins: props.corsAllowOrigins ?? defaultCors,
      },
    });

    const readIntegration = new apigwv2Integrations.HttpLambdaIntegration(
      "AuthReadIntegration",
      this.authReadFn
    );
    const adminIntegration = new apigwv2Integrations.HttpLambdaIntegration(
      "AuthAdminIntegration",
      this.authAdminFn
    );

    this.httpApi.addRoutes({
      path: "/me",
      methods: [apigwv2.HttpMethod.GET],
      integration: readIntegration,
    });

    this.httpApi.addRoutes({
      path: "/admin/{proxy+}",
      methods: [
        apigwv2.HttpMethod.GET,
        apigwv2.HttpMethod.POST,
        apigwv2.HttpMethod.PUT,
        apigwv2.HttpMethod.DELETE,
      ],
      integration: adminIntegration,
    });

    this.httpApiUrl = this.httpApi.url ?? "";

    // ----------------------------
    // Outputs
    // ----------------------------
    new cdk.CfnOutput(this, "AuthApiBaseUrl", { value: this.httpApiUrl });
    new cdk.CfnOutput(this, "Issuer", { value: this.issuer });
    new cdk.CfnOutput(this, "UserPoolId", { value: this.userPool.userPoolId });
    new cdk.CfnOutput(this, "WebClientId", { value: this.webClient.userPoolClientId });

    new cdk.CfnOutput(this, "AuthHost", { value: authHost });
    new cdk.CfnOutput(this, "AuthCloudFrontEndpoint", {
      value: this.cognitoDomain.cloudFrontEndpoint,
    });

    new cdk.CfnOutput(this, "AuthReadFnArn", { value: this.authReadFnArn });
    new cdk.CfnOutput(this, "AuthAdminFnArn", { value: this.authAdminFnArn });

    if (props.platformWildcardCertArnUsEast1) {
      new cdk.CfnOutput(this, "PlatformWildcardCertArnUsEast1", {
        value: props.platformWildcardCertArnUsEast1,
      });
    }
  }
}
