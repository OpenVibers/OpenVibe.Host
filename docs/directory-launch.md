# Directory launch

Directory is a public read service at openvibe.directory, port 5281. It refreshes public source feeds at startup and every six hours. The local-business pilot reads a bounded OpenStreetMap map area. No database, account principal, or provider credentials are needed for this public first release.

Prepare `/opt/openvibe.directory` from OpenVibers/OpenVibe.Directory with PORT=5281, HOST=127.0.0.1, and BASE_URL=https://openvibe.directory. Run `sudo python3 scripts/register-directory.py` from the current Host checkout; it checks port collisions and refuses to replace a differing entry. Deploy the ready Directory PR through merge-deploy.sh, install the nginx vhost with ov-vhost-install, and verify the home, `/api/v1/kinds`, `/api/v1/entries`, `/sitemap.xml`, and `/llms.txt`.

The service has no private-person search or reverse phone lookup. A later opt-in claim flow needs a signed-in identity and persistent storage before it can publish any person entry.
