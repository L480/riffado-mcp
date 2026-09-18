# Third-party notices

This project is MIT licensed (see [`LICENSE`](./LICENSE)) and contains code
derived from the third-party work listed below. Its copyright notice and
license text are reproduced here as that license requires.

## mcp-picnic

`src/transports/streamable-http.ts` derives from the Streamable HTTP transport
of [ivo-toby/mcp-picnic](https://github.com/ivo-toby/mcp-picnic).

It was taken from this project's author's own
[L480/mcp-picnic](https://github.com/L480/mcp-picnic) fork, and the OAuth 2.1
wrapper it integrates — `src/transports/oauth-provider.ts`, the
`StaticTokenOAuthProvider` that lets OAuth-only clients such as Claude's
custom connectors authenticate against a shared secret — is that author's own
work, written in the fork. No third-party notice is required for that part;
the notice below covers the upstream transport it sits on.

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

The GitHub Actions layout under `.github/workflows/` follows this author's
[L480/cloudflare-dyndns](https://github.com/L480/cloudflare-dyndns)
(Apache-2.0) — release-on-tag with multi-arch build, SBOM, provenance and
cosign signing, plus the CI job matrix. Same author, so no notice is required;
listed for provenance.

## Runtime dependencies

npm dependencies keep their own licenses; see `package-lock.json` and the
`node_modules/*/LICENSE` files of an installed tree.
