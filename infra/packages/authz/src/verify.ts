import { CognitoJwtVerifier } from "aws-jwt-verify";

let verifier: any;

export function verifyAccessToken(token: string) {
  if (!verifier) {
    verifier = CognitoJwtVerifier.create({
      userPoolId: process.env.USER_POOL_ID!,
      clientId: process.env.CLIENT_ID!,
      tokenUse: "access",
    });
  }

  return verifier.verify(token);
}
