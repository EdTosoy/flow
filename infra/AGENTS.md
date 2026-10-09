# Flow deployment boundaries

Read root instructions, Phase 15 documentation and ADR-018 before changes.

- Use only `iamadmin-general`, account `163596511125`, region `us-east-1`.
- `bootstrap` owns persistent prerequisites; `demo` owns disposable runtime.
- Inspect saved plans and verify identity before every apply. Deployment tooling rejects bootstrap deletes and unexpected resource types.
- State is sensitive, encrypted and versioned; use native S3 locking. Never commit state, saved plans, generated backend configuration or local variable files.
- Creating the public `flow.edtosoy.com` child zone is a mandatory STOP checkpoint. Report its actual nameservers and wait for the user to add Cloudflare NS records. Verify public delegation after confirmation before certificate validation or HTTPS deployment.
- Never migrate the Cloudflare parent zone or require Cloudflare tokens/providers.
- No NAT, public database, workload AdministratorAccess, live Stripe, alternate queue or financial semantic changes.
- Runtime credentials remain narrow. Owner credentials belong only to one-shot migration/provisioning. Never expose secrets through outputs, plans/logs shared with users, task environment literals or images.
- A successful apply is not financial assurance or Phase 15 completion. Record deployed proof and actual runtime destruction separately.
