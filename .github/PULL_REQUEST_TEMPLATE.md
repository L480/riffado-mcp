## What and why

<!-- What changes, and what problem it solves. -->

## Checks

- [ ] `npm run lint`
- [ ] `npm run format:check`
- [ ] `npm run typecheck`
- [ ] `npm test`
- [ ] Integration suite run, if the data layer changed

## Invariants

- [ ] Read-only is still enforced by the pool's `default_transaction_read_only`
- [ ] Nothing new writes to stdout on the stdio transport
- [ ] No decrypted recording content is written to disk
- [ ] No real tokens, keys or hostnames in the diff

<!-- See CONTRIBUTING.md for why each of these is load-bearing. -->
