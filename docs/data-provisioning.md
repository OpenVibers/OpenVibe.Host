# Provisioning a service database

`sudo ovhost data provision <service> [--dry-run]` runs `roles/data/add-service.sh` from the installed ovhost tree. The command requires a service listed in the host inventory and root privileges for a real run. Dry run prints the command without changing the host.

The role creates the PostgreSQL database and roles, a Valkey user, and sets `DATABASE_URL`, `DATABASE_DIRECT_URL`, `VALKEY_URL` and `VALKEY_PREFIX` in the service env file. It is idempotent and prints setting names rather than values. ovhost redacts connection URLs and password assignments from command output.
