# Third-party notices

This project is MIT licensed (see [`LICENSE`](./LICENSE)) and contains code
adapted from the third-party work listed below. Their copyright notices and
license texts are reproduced here as those licenses require.

## mcp-picnic

`src/transports/oauth-provider.ts` and `src/transports/streamable-http.ts` are
adapted from [mcp-picnic](https://github.com/ivo-toby/mcp-picnic) (via the
[L480/mcp-picnic](https://github.com/L480/mcp-picnic) fork, which added the
OAuth wrapper these files are based on). The `StaticTokenOAuthProvider`
approach — wrapping a shared secret in an OAuth 2.1 flow so that clients which
only speak OAuth can authenticate — originates there.

```
MIT License

Copyright (c) 2024 Ivo Toby

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## cloudflare-dyndns

The GitHub Actions layout under `.github/workflows/` follows
[L480/cloudflare-dyndns](https://github.com/L480/cloudflare-dyndns)
(Apache-2.0, same author as this project) — release-on-tag with multi-arch
build, SBOM, provenance and cosign signing, plus the CI job matrix. Credited
for provenance; no notice is required.

## Runtime dependencies

npm dependencies keep their own licenses; see `package-lock.json` and the
`node_modules/*/LICENSE` files of an installed tree.
