// infra/lib/domains/platform/PlatformDomainsEuStack.ts
import * as cdk from "aws-cdk-lib";
import { Construct } from "constructs";
import * as route53 from "aws-cdk-lib/aws-route53";
import * as acm from "aws-cdk-lib/aws-certificatemanager";

export interface PlatformDomainsEuStackProps extends cdk.StackProps {
  stage: string;
  platformRootDomain: string; // e.g. "wasit-platform.shop"
}

export class PlatformDomainsEuStack extends cdk.Stack {
  // Hosted zone
  public readonly platformZone: route53.IHostedZone;

  // Contract outputs/props expected by downstream stacks
  public readonly platformRootDomain: string;
  public readonly platformHostedZoneId: string;

  // Stable hosts (contract)
  public readonly adminHost: string;
  public readonly authHost: string;
  public readonly apiHost: string;
  public readonly internalHost: string;

  // Regional API cert ARN (contract)
  public readonly apiCertArnRegional: string;

  constructor(scope: Construct, id: string, props: PlatformDomainsEuStackProps) {
    super(scope, id, props);

    // ----------------------------
    // Hosted Zone (authoritative)
    // ----------------------------
    const platformZone = new route53.PublicHostedZone(this, "PlatformZone", {
      zoneName: props.platformRootDomain,
    });

    this.platformZone = platformZone;
    this.platformHostedZoneId = platformZone.hostedZoneId;
    this.platformRootDomain = props.platformRootDomain;

    // ----------------------------
    // Conventional platform hosts
    // ----------------------------
    this.apiHost = `api.${props.platformRootDomain}`;
    this.authHost = `auth.${props.platformRootDomain}`;
    this.adminHost = `admin.${props.platformRootDomain}`;
    this.internalHost = `internal.${props.platformRootDomain}`;

    // ----------------------------
    // Regional cert for API domain (EU)
    // ----------------------------
    const apiCert = new acm.Certificate(this, "ApiCertRegional", {
      domainName: this.apiHost,
      validation: acm.CertificateValidation.fromDns(platformZone),
    });

    this.apiCertArnRegional = apiCert.certificateArn;

    /**
     * IMPORTANT:
     * Do NOT create the Cognito custom-domain certificate here.
     * Cognito UserPool custom domains are CloudFront-backed, and require the ACM cert in us-east-1.
     * That cert is owned by PlatformCertsUsEast1Stack (us-east-1).
     */

    // ----------------------------
    // Outputs
    // ----------------------------
    new cdk.CfnOutput(this, "PlatformHostedZoneId", { value: this.platformHostedZoneId });
    new cdk.CfnOutput(this, "PlatformRootDomain", { value: this.platformRootDomain });

    new cdk.CfnOutput(this, "ApiHost", { value: this.apiHost });
    new cdk.CfnOutput(this, "AuthHost", { value: this.authHost });
    new cdk.CfnOutput(this, "AdminHost", { value: this.adminHost });
    new cdk.CfnOutput(this, "InternalHost", { value: this.internalHost });

    new cdk.CfnOutput(this, "ApiCertArnRegional", { value: this.apiCertArnRegional });

    new cdk.CfnOutput(this, "PlatformHostedZoneNameServers", {
      value: platformZone.hostedZoneNameServers
        ? cdk.Fn.join(",", platformZone.hostedZoneNameServers)
        : "",
    });
  }
}
