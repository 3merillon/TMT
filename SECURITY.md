# Security reporting

Do not put credentials, exploitable vulnerability details, or private player/session data in public issues. Contact the maintainer through the [developer website](https://3merillon.com) to arrange private disclosure. GitHub private vulnerability reporting is also appropriate if enabled; this document does not imply it is already enabled.

Include the affected revision, reproduction steps, impact, and a minimal redacted example. There is no guaranteed response time or paid support policy.

Peer-hosted matches trust the simulation host. Replicated state is not an anti-cheat boundary. Room passwords, validation, authority leases, and relay credentials serve specific admission/transport purposes; they do not make a player's browser a trusted dedicated server.

Keep deployment secrets in Wrangler secrets or ignored local files. Never put TURN API credentials in `VITE_` variables or client bundles. See [hosting](server/README.md).
