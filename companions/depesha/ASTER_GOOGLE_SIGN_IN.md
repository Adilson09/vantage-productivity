# Google sign-in in Aster Mail

Aster Mail opens Google's authorization page in the system browser. It uses S256 PKCE, a random state value, and a temporary callback at `http://127.0.0.1:<available-port>/`. The token exchange uses Google's HTTPS endpoint. A browser return is not a connected mailbox: Aster Mail still checks the refresh token, granted mail scope, identity, and account connection. The refresh token stays in the separate Aster keyring namespace. Your ordinary Google password is never entered in Aster Mail.

The distributor must supply its authorized Google OAuth registration of type **Desktop app**, using `ASTER_MAIL_GOOGLE_CLIENT_ID` and optionally `ASTER_MAIL_GOOGLE_CLIENT_SECRET` during compilation. A source build without registration offers local OAuth-client setup; pasted identifiers and optional secrets are trimmed. These are application registration details, not the Google account password. Desktop clients are public clients and cannot keep an embedded client secret confidential. Do not include registration JSON or its secret in source distributions, logs, or manifests.

Google consent requests the `https://mail.google.com/` scope required for IMAP/SMTP XOAUTH2, plus identity scopes. A registration in Testing permits consent only for its listed test users; Google may refuse other accounts or Workspace administrators may restrict access. A refusal or cancelled browser flow never creates a successful grant. Public distribution requires the application's own appropriate Google consent/verification setup.

References: [Google desktop OAuth guide](https://developers.google.com/identity/protocols/oauth2/native-app), [Gmail XOAUTH2 and scopes](https://developers.google.com/workspace/gmail/imap/xoauth2-protocol).
