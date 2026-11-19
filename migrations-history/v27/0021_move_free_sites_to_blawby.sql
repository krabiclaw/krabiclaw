-- Move the active address in place so a free site keeps its canonical role
-- and a site with a custom primary domain keeps that choice.
SELECT CASE WHEN EXISTS (
  SELECT 1 FROM organization_domains
  WHERE type = 'subdomain' AND status = 'active' AND domain LIKE '%.blawby.com'
) THEN json_extract('{}', 'BLAWBY_SUBDOMAIN_ALREADY_REGISTERED') ELSE 1 END;
--> statement-breakpoint
UPDATE organization_domains
SET domain = substr(domain, 1, length(domain) - length('krabiclaw.com')) || 'blawby.com',
    dns_target = 'blawby.com',
    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE type = 'subdomain' AND status = 'active' AND domain LIKE '%.krabiclaw.com';
--> statement-breakpoint
INSERT INTO organization_domains
  (id, domain, former_organization_id, type, role, status, successor_domain, retired_at, dns_status)
SELECT id || '-legacy-krabiclaw',
       substr(domain, 1, length(domain) - length('blawby.com')) || 'krabiclaw.com',
       organization_id, 'subdomain', 'secondary', 'retired', domain,
       strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), 'valid'
FROM organization_domains
WHERE type = 'subdomain' AND status = 'active' AND domain LIKE '%.blawby.com';
