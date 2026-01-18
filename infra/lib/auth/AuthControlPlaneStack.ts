// infra/lib/auth/AuthControlPlaneStack.ts
import * as path from "path";
import * as cdk from "aws-cdk-lib";
import { Construct } from "constructs";
import * as cognito from "aws-cdk-lib/aws-cognito";
import * as ddb from "aws-cdk-lib/aws-dynamodb";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as apigwv2 from "aws-cdk-lib/aws-apigatewayv2";
import * as apigwv2Integrations from "aws-cdk-lib/aws-apigatewayv2-integrations";
import * as apigwv2Auth from "aws-cdk-lib/aws-apigatewayv2-authorizers";
import * as secretsmanager from "aws-cdk-lib/aws-secretsmanager";
import * as iam from "aws-cdk-lib/aws-iam";
import { NodejsFunction, OutputFormat } from "aws-cdk-lib/aws-lambda-nodejs";

export interface AuthControlPlaneStackProps extends cdk.StackProps {
  prefix: string;

  // Creates this secret if missing (placeholder values REPLACE_ME).
  googleSecretName: string;
  createGoogleSecretIfMissing: boolean;

  // IMPORTANT: keep false until you actually have real Google creds.
  enableGoogleIdp?: boolean;

  callbackUrls: string[];
  logoutUrls: string[];

  usersStateTableName?: string; // default "users_state"
  authzGrantsTableName?: string; // default "authz_grants"

  // Optional: override Cognito domain prefix (must be globally unique)
  cognitoDomainPrefix?: string;
}

export class AuthControlPlaneStack extends cdk.Stack {
  public readonly userPool: cognito.UserPool;
  public readonly webClient: cognito.UserPoolClient;
  public readonly usersStateTable: ddb.Table;
  public readonly authzGrantsTable: ddb.Table;

  // NOTE: keep type as lambda.IFunction so NodejsFunction is acceptable
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
    // Secrets Manager: Google OAuth creds (placeholder)
    // ----------------------------
    let googleSecret: secretsmanager.ISecret;

    if (props.createGoogleSecretIfMissing) {
      googleSecret = new secretsmanager.Secret(this, "GoogleOAuthSecret", {
        secretName: props.googleSecretName,
        description:
          'Google OAuth credentials JSON: {"clientId":"...","clientSecret":"..."}',
        secretObjectValue: {
          clientId: cdk.SecretValue.unsafePlainText("REPLACE_ME"),
          clientSecret: cdk.SecretValue.unsafePlainText("REPLACE_ME"),
        },
        removalPolicy: cdk.RemovalPolicy.RETAIN,
      });
    } else {
      googleSecret = secretsmanager.Secret.fromSecretNameV2(
        this,
        "GoogleOAuthSecretImported",
        props.googleSecretName
      );
    }

    // NOTE:
    // Do NOT read secret values unless enableGoogleIdp=true.
    // Otherwise CDK may try to synth SecretValue into template and fail validation.

    // ----------------------------
    // Cognito User Pool
    // ----------------------------
    this.userPool = new cognito.UserPool(this, "UserPool", {
      userPoolName: `${prefix}-users`,
      signInAliases: { email: true },
      selfSignUpEnabled: false,
      standardAttributes: {
        email: { required: true, mutable: false },
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

    // User types via groups
    new cognito.CfnUserPoolGroup(this, "GodAdminGroup", {
      userPoolId: this.userPool.userPoolId,
      groupName: "GodAdmin",
      description: "Full platform control",
    });

    new cognito.CfnUserPoolGroup(this, "InternalOpsGroup", {
      userPoolId: this.userPool.userPoolId,
      groupName: "InternalOps",
      description: "Operational users",
    });

    new cognito.CfnUserPoolGroup(this, "SellerGroup", {
      userPoolId: this.userPool.userPoolId,
      groupName: "Seller",
      description: "Sellers / merchants",
    });

    // ----------------------------
    // AWS-provided Cognito domain (Hosted UI) — fastest path
    // ----------------------------
    const domainPrefix =
      props.cognitoDomainPrefix ??
      // must be globally unique; adjust if collision happens
      `${prefix}-auth`;

    const domain = this.userPool.addDomain("HostedDomain", {
      cognitoDomain: { domainPrefix },
    });

    const hostedDomainHost = `${domainPrefix}.auth.${this.region}.amazoncognito.com`;

    this.cognitoHostedDomain = hostedDomainHost;
    this.googleRedirectUri = `https://${hostedDomainHost}/oauth2/idpresponse`;

    // Issuer used by API Gateway JWT authorizer
    this.issuer = `https://cognito-idp.${this.region}.amazonaws.com/${this.userPool.userPoolId}`;

    // ----------------------------
    // Optional: Google Identity Provider
    // ONLY enable once you have real clientId/secret
    // ----------------------------
    let googleProvider: cognito.CfnUserPoolIdentityProvider | undefined;

    if (enableGoogleIdp) {
      const googleClientId = googleSecret
        .secretValueFromJson("clientId")
        .unsafeUnwrap();

      const googleClientSecret = googleSecret
        .secretValueFromJson("clientSecret")
        .unsafeUnwrap();

      googleProvider = new cognito.CfnUserPoolIdentityProvider(
        this,
        "GoogleProvider",
        {
          providerName: "Google",
          providerType: "Google",
          userPoolId: this.userPool.userPoolId,
          providerDetails: {
            client_id: googleClientId,
            client_secret: googleClientSecret,
            authorize_scopes: "profile email",
          },
          attributeMapping: {
            email: "email",
            name: "name",
            email_verified: "email_verified",
          },
        }
      );
    }

    // ----------------------------
    // User Pool Client (OAuth code grant for web apps)
    // While Google isn't enabled, allow Cognito native sign-in.
    // ----------------------------
    const supportedProviders: cognito.UserPoolClientIdentityProvider[] = [
      cognito.UserPoolClientIdentityProvider.COGNITO,
    ];
    if (enableGoogleIdp) {
      supportedProviders.push(cognito.UserPoolClientIdentityProvider.GOOGLE);
    }

    this.webClient = new cognito.UserPoolClient(this, "WebClient", {
      userPool: this.userPool,
      userPoolClientName: `${prefix}-web`,
      generateSecret: false,
      oAuth: {
        flows: { authorizationCodeGrant: true },
        scopes: [
          cognito.OAuthScope.OPENID,
          cognito.OAuthScope.EMAIL,
          cognito.OAuthScope.PROFILE,
        ],
        callbackUrls: props.callbackUrls,
        logoutUrls: props.logoutUrls,
      },
      supportedIdentityProviders: supportedProviders,
    });

    // Ensure client waits for IdP when enabled
    if (googleProvider) {
      (this.webClient.node.defaultChild as cognito.CfnUserPoolClient).addDependency(
        googleProvider
      );
    }

    // ----------------------------
    // DynamoDB: users_state
    // ----------------------------
    this.usersStateTable = new ddb.Table(this, "UsersStateTable", {
      tableName: props.usersStateTableName ?? "users_state",
      partitionKey: { name: "userId", type: ddb.AttributeType.STRING }, // Cognito sub
      billingMode: ddb.BillingMode.PAY_PER_REQUEST,
      pointInTimeRecovery: true,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    // ----------------------------
    // DynamoDB: authz_grants (authorization graph)
    // ----------------------------
    this.authzGrantsTable = new ddb.Table(this, "AuthzGrantsTable", {
      tableName: props.authzGrantsTableName ?? "authz_grants",
      partitionKey: { name: "pk", type: ddb.AttributeType.STRING },
      sortKey: { name: "sk", type: ddb.AttributeType.STRING },
      billingMode: ddb.BillingMode.PAY_PER_REQUEST,
      pointInTimeRecovery: true,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    this.authzGrantsTable.addGlobalSecondaryIndex({
      indexName: "gsi1_resource",
      partitionKey: { name: "gsi1pk", type: ddb.AttributeType.STRING },
      sortKey: { name: "gsi1sk", type: ddb.AttributeType.STRING },
      projectionType: ddb.ProjectionType.ALL,
    });

    // ----------------------------
    // Control-plane Lambda (routes: /admin/*)
    // Bundled via NodejsFunction so it can import @wasit/authz (workspace package)
    // ----------------------------
    this.controlPlaneFn = new NodejsFunction(this, "AuthControlPlaneFn", {
      runtime: lambda.Runtime.NODEJS_20_X,

      // IMPORTANT: points to your JS entry (ESM-friendly) and bundles deps.
      entry: path.join(__dirname, "../../lambda/auth/index.js"),
      handler: "handler",

      timeout: cdk.Duration.seconds(15),
      memorySize: 256,

      environment: {
        USER_POOL_ID: this.userPool.userPoolId,
        USERS_STATE_TABLE: this.usersStateTable.tableName,
        AUTHZ_GRANTS_TABLE: this.authzGrantsTable.tableName,
      },

      bundling: {
        // Bundle everything including @wasit/authz and AWS SDK v3 deps
        externalModules: [],
        format: OutputFormat.ESM,
        target: "node20",
        sourceMap: true,
        minify: false,
      },
    });

    this.usersStateTable.grantReadWriteData(this.controlPlaneFn);
    this.authzGrantsTable.grantReadWriteData(this.controlPlaneFn);

    this.controlPlaneFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: [
          "cognito-idp:AdminCreateUser",
          "cognito-idp:AdminAddUserToGroup",
          "cognito-idp:AdminRemoveUserFromGroup",
          "cognito-idp:AdminUpdateUserAttributes",
          "cognito-idp:AdminDisableUser",
          "cognito-idp:AdminEnableUser",
          "cognito-idp:AdminGetUser",
          "cognito-idp:ListUsers",
          "cognito-idp:ListGroups",
          "cognito-idp:AdminListGroupsForUser",
        ],
        resources: [this.userPool.userPoolArn],
      })
    );

    // ----------------------------
    // HTTP API Gateway (JWT-protected)
    // ----------------------------
    this.httpApi = new apigwv2.HttpApi(this, "AuthControlPlaneHttpApi", {
      apiName: `${prefix}-auth-control-plane`,
    });

    const integration = new apigwv2Integrations.HttpLambdaIntegration(
      "ControlPlaneIntegration",
      this.controlPlaneFn
    );

    const authorizer = new apigwv2Auth.HttpJwtAuthorizer(
      "CognitoJwtAuthorizer",
      this.issuer,
      { jwtAudience: [this.webClient.userPoolClientId] }
    );

    const add = (routePath: string, method: apigwv2.HttpMethod) => {
      this.httpApi.addRoutes({
        path: routePath,
        methods: [method],
        integration,
        authorizer,
      });
    };

add("/admin/users", apigwv2.HttpMethod.POST);
add("/admin/users", apigwv2.HttpMethod.GET);

add("/admin/users/{userId}", apigwv2.HttpMethod.GET);
add("/admin/users/{userId}/state", apigwv2.HttpMethod.PATCH);

add("/admin/grants", apigwv2.HttpMethod.POST);
add("/admin/grants", apigwv2.HttpMethod.GET);
add("/admin/grants", apigwv2.HttpMethod.DELETE);

    // ----------------------------
    // Outputs
    // ----------------------------
    new cdk.CfnOutput(this, "Auth_Issuer", {
      value: this.issuer,
      exportName: `${prefix}-auth-issuer`,
    });

    new cdk.CfnOutput(this, "Auth_UserPoolId", {
      value: this.userPool.userPoolId,
      exportName: `${prefix}-auth-userpool-id`,
    });

    new cdk.CfnOutput(this, "Auth_WebClientId", {
      value: this.webClient.userPoolClientId,
      exportName: `${prefix}-auth-webclient-id`,
    });

    new cdk.CfnOutput(this, "Auth_CognitoDomain", {
      value: this.cognitoHostedDomain,
      exportName: `${prefix}-auth-cognito-domain`,
    });

    new cdk.CfnOutput(this, "Auth_GoogleRedirectUri", {
      value: this.googleRedirectUri,
      exportName: `${prefix}-auth-google-redirect-uri`,
    });

    new cdk.CfnOutput(this, "UsersStateTableName", {
      value: this.usersStateTable.tableName,
      exportName: `${prefix}-users-state-table`,
    });

    new cdk.CfnOutput(this, "AuthzGrantsTableName", {
      value: this.authzGrantsTable.tableName,
      exportName: `${prefix}-authz-grants-table`,
    });

    new cdk.CfnOutput(this, "ControlPlaneApiUrl", {
      value: this.httpApi.apiEndpoint,
      exportName: `${prefix}-control-plane-api-url`,
    });

    new cdk.CfnOutput(this, "Auth_GoogleIdpEnabled", {
      value: enableGoogleIdp ? "true" : "false",
      exportName: `${prefix}-auth-google-enabled`,
    });
  }
}
