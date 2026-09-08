"use strict";

/**
 * Cognito trigger that keeps the user pool restricted to a set of email domains.
 *
 * Wired to both PreSignUp and PreAuthentication:
 *
 *   PreSignUp        — the only chance to stop a federated Google identity from
 *                      ever becoming a user pool user. Throwing here means no
 *                      user row is created and the hosted UI shows an error.
 *   PreAuthentication — re-checked on every sign-in, so removing a domain from
 *                      ALLOWED_EMAIL_DOMAINS locks out users that were created
 *                      while it was still allowed.
 *
 * ALLOWED_EMAIL_DOMAINS is a comma-separated list. Matching is exact on the part
 * after the last "@", lowercased, so "user@evil-nudge-labs.com" does not match
 * "nudge-labs.com".
 */

const allowedDomains = (process.env.ALLOWED_EMAIL_DOMAINS || "")
  .split(",")
  .map((domain) => domain.trim().toLowerCase())
  .filter(Boolean);

function emailDomain(email) {
  if (typeof email !== "string") {
    return null;
  }
  const at = email.lastIndexOf("@");
  if (at <= 0 || at === email.length - 1) {
    return null;
  }
  return email.slice(at + 1).toLowerCase();
}

function assertAllowed(event) {
  if (allowedDomains.length === 0) {
    // Fail closed: an empty allow-list is a misconfiguration, not "allow all".
    throw new Error("Sign-in is not available: no allowed email domains are configured.");
  }

  const attributes = (event.request && event.request.userAttributes) || {};
  const domain = emailDomain(attributes.email);

  if (!domain) {
    throw new Error("Sign-in is restricted: the identity provider did not supply an email address.");
  }
  if (!allowedDomains.includes(domain)) {
    throw new Error(`Sign-in is restricted to ${allowedDomains.join(", ")} accounts.`);
  }
}

exports.handler = async (event) => {
  assertAllowed(event);

  if (event.triggerSource === "PreSignUp_ExternalProvider") {
    // Federated users have already proven ownership of the address to Google,
    // so skip the confirmation step that would otherwise leave them unusable.
    event.response.autoConfirmUser = true;
    event.response.autoVerifyEmail = true;
  } else if (event.triggerSource && event.triggerSource.startsWith("PreSignUp_")) {
    // Local (username/password) sign-up is disabled on the pool; refuse
    // explicitly in case someone re-enables it without revisiting this trigger.
    throw new Error("Direct sign-up is disabled. Sign in with your Google account.");
  }

  return event;
};
