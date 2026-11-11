# Directory launch

Directory serves source-linked public listings at openvibe.directory, port 5281. It refreshes public feeds at startup and every six hours. The local-business pilot reads a bounded OpenStreetMap map area. Signed-in, opt-in people listings use the dedicated `ov_directory` PostgreSQL database and a Network OAuth client.

Prepare `/opt/openvibe.directory` from OpenVibers/OpenVibe.Directory with PORT=5281, HOST=127.0.0.1, and BASE_URL=https://openvibe.directory. Run `sudo python3 scripts/register-directory.py` from the current Host checkout; it checks port collisions and refuses to replace a differing entry. Deploy the ready Directory PR through merge-deploy.sh, install the nginx vhost with ov-vhost-install, and verify the home, `/api/v1/kinds`, `/api/v1/entries`, `/sitemap.xml`, and `/llms.txt`.

After the people-listing PRs ship, rerun the registration script to upgrade the existing inventory entry. Run `sudo ovhost data provision directory`; use Network's service-principal script to rotate the seeded `directory` OAuth client into `/etc/openvibe/directory.env` without printing its secret. Deploy Directory, then check `/auth/health` and that `/people/me` directs an anonymous visitor to sign-in. The service has no imported people, private-person search, or reverse phone lookup.
