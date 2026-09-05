# cloudflare-ops: automation (Python SDK, cf-terraforming, BIND import)

Supporting reference for the `cloudflare-ops` skill. Read when an operation
touches many zones or records at once, or when adopting hand-managed
resources into Terraform.

Contents: Python SDK with bounded concurrency; retry pattern for raw HTTP;
cf-terraforming generate/import; BIND zone import.

## Python SDK (bulk operations across many zones)

For operations that touch 10+ zones or need async (e.g. bulk DNS export, custom-hostname audit), use the official Python SDK with concurrency. Pattern:

```python
import asyncio, os
from cloudflare import AsyncCloudflare

cf = AsyncCloudflare(api_token=os.environ["CLOUDFLARE_API_TOKEN"])

async def per_zone(zone):
    records = []
    async for rec in cf.dns.records.list(zone_id=zone.id, per_page=100):
        records.append(rec)
    return zone.name, records

async def main():
    zones = [z async for z in cf.zones.list(per_page=50)]
    # Bounded concurrency to stay under rate limit
    sem = asyncio.Semaphore(8)
    async def bounded(z):
        async with sem:
            return await per_zone(z)
    results = await asyncio.gather(*(bounded(z) for z in zones))
    for name, recs in results:
        print(f"{name}: {len(recs)} records")

asyncio.run(main())
```

**Why async + semaphore**: blanket-`gather` on 100+ zones will trip rate limits. `asyncio.Semaphore(8)` caps concurrent requests.

**Retry pattern** (the SDK retries built-in, but for raw HTTP):

```python
import httpx, tenacity

@tenacity.retry(
    retry=tenacity.retry_if_exception_type(httpx.HTTPStatusError),
    wait=tenacity.wait_exponential(multiplier=2, min=2, max=30),
    stop=tenacity.stop_after_attempt(5),
)
async def cf_get(client, url):
    r = await client.get(url, headers={"Authorization": f"Bearer {TOKEN}"})
    r.raise_for_status()
    return r.json()
```

## cf-terraforming: importing existing resources into Terraform

When you have hand-managed Cloudflare and want IaC:

```sh
# 1. Install
go install github.com/cloudflare/cf-terraforming@latest

# 2. Generate .tf for an existing resource type
cf-terraforming generate \
  --resource-type "cloudflare_record" \
  --zone $ZONE_ID > dns.tf

# 3. Generate import commands (one per resource)
cf-terraforming import \
  --resource-type "cloudflare_record" \
  --zone $ZONE_ID > dns.imports.sh

# 4. Run the imports (one terraform import call per resource)
bash dns.imports.sh

# 5. Verify drift is zero
terraform plan   # should report "no changes"
```

Supported resource types: `cloudflare_record`, `cloudflare_zone_settings_override`, `cloudflare_ruleset`, `cloudflare_access_application`, `cloudflare_tunnel`, `cloudflare_pages_project`, `cloudflare_worker_script`, ~80 more. Run `cf-terraforming -h` for the full list.

**Pair with the `terraform` skill** for module structure + state backends.

## BIND zone file -> Cloudflare DNS

For migrating from a traditional DNS host that exports BIND:

```sh
# 1. Get the BIND file from the old provider (export feature)
# 2. Convert via dnscontrol, octodns, or a custom Python script
# 3. Push via terraform OR direct API bulk-create

# Or via Cloudflare's import endpoint (zone-level)
curl -sS -X POST "https://api.cloudflare.com/client/v4/zones/$ZONE_ID/dns_records/import" \
  -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
  -F "file=@zone.bind"
```
