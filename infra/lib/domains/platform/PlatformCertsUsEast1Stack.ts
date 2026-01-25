// infra/lib/domains/platform/PlatformCertsUsEast1Stack.ts
import * as cdk from "aws-cdk-lib";
import { Construct } from "constructs";
import * as route53 from "aws-cdk-lib/aws-route53";
import * as acm from "aws-cdk-lib/aws-certificatemanager";

export interface PlatformCertsUsEast1StackProps extends cdk.StackProps {
  stage: string;

  platformHostedZoneId: string;
  platformRootDomain: string; // "wasit-platform.shop"
}

export class PlatformCertsUsEast1Stack extends cdk.Stack {
  /**
   * Wildcard cert for CloudFront / edge use-cases.
   * NOTE: CloudFront requires ACM certs in us-east-1.
   */
  public readonly wildcardCertArnUsEast1: string;

  /**
   * Dedicated auth cert for Cognito custom domain.
   * NOTE: Cognito UserPool custom domain is CloudFront-backed → cert must be in us-east-1.
   */
  public readonly authCertArnUsEast1: string;

  constructor(scope: Construct, id: string, props: PlatformCertsUsEast1StackProps) {
    super(scope, id, props);

    const zone = route53.HostedZone.fromHostedZoneAttributes(this, "PlatformZoneImported", {
      hostedZoneId: props.platformHostedZoneId,
      zoneName: props.platformRootDomain,
    });

    /**
     * CRITICAL FOR COGNITO CUSTOM DOMAINS:
     * Cognito validates that the PARENT domain has a resolvable public A record.
     * For auth.<root>, the parent is <root>.
     *
     * This apex A record does NOT need to point to a “real” service; it only needs to exist.
     * Use a TEST-NET IP (RFC5737) to avoid unintended traffic.
     */
    new route53.ARecord(this, "PlatformApexARecordForCognito", {
      zone,
      recordName: "", // apex: wasit-platform.shop
      target: route53.RecordTarget.fromIpAddresses("198.51.100.1"),
      ttl: cdk.Duration.minutes(5),
    });

    // Wildcard cert for future CloudFront usage: *.wasit-platform.shop (us-east-1)
    const wildcardCert = new acm.Certificate(this, "PlatformWildcardCertUsEast1", {
      domainName: `*.${props.platformRootDomain}`,
      validation: acm.CertificateValidation.fromDns(zone),
    });
    this.wildcardCertArnUsEast1 = wildcardCert.certificateArn;

    // Dedicated cert for Cognito custom domain: auth.<root> (us-east-1)
    const authCert = new acm.Certificate(this, "AuthDomainCertUsEast1", {
      domainName: `auth.${props.platformRootDomain}`,
      validation: acm.CertificateValidation.fromDns(zone),
    });
    this.authCertArnUsEast1 = authCert.certificateArn;

    new cdk.CfnOutput(this, "WildcardCertArnUsEast1", {
      value: this.wildcardCertArnUsEast1,
    });

    new cdk.CfnOutput(this, "AuthCertArnUsEast1", {
      value: this.authCertArnUsEast1,
    });

    new cdk.CfnOutput(this, "PlatformApexARecordForCognitoIp", {
      value: "198.51.100.1",
    });
  }
}
