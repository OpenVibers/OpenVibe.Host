# Compare launch

Compare is a stateless public read service at openvibe.compare, port 5280. Its only local state is a ten-minute cache. No database, account principal or provider credentials are needed. The service/site manifest and compare.comparison@1 are proposed separately in Contracts; the inventory lifecycle override permits launch before that library is released.

After preparing `/opt/openvibe.compare` from OpenVibers/OpenVibe.Compare and setting PORT=5280, HOST=127.0.0.1 and BASE_URL=https://openvibe.compare with ov-svc-env, run `sudo python3 scripts/register-compare.py`. This checks port collisions and refuses to overwrite a differing existing service. Ship the ready Compare PR through merge-deploy.sh; install its nginx vhost with ov-vhost-install after the domain certificate exists. The vhost replaces the temporary redirect. Verify the home, `/comparisons/ai-models`, `/api/v1/comparisons`, `/sitemap.xml` and the Markdown response.

Upstreams are public HTTPS reads: Exchange market, Bench chat.arena board and codes.patch runs, Codes harnesses, and Billing public plans. A failed upstream is shown as unavailable, never a fabricated or zero measurement. Billing's public plans endpoint exposes only checkout rate definitions; customer and ledger routes remain restricted.
