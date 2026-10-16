# Licensing

Colonie is a fork of an upstream open-source project. Everything in this
repository is open source under the [Apache License 2.0](LICENSE), with a few
notes.

## The retired carve-out: `enterprise/`

Upstream kept an `enterprise/` folder that was source-available under its own
license rather than Apache 2.0, and whose features needed a license key in
production. Colonie removed that folder on 2026-10-14 (`SPEC.md`, *Product
direction change*; `PLAN.md` M11 step 2), because its terms forbid hosting for
third parties and white-labelling without a written partner agreement, and this
fork does not use its features.

What that means here:

- There is no carve-out left. The whole repository is Apache 2.0.
- `server/enterprise.ts` stays as the edition hook and always reports
  `{"edition":"oss"}`. Setting `COLONIE_LICENSE_KEY` changes nothing; the response
  explains that no enterprise layer exists.
- The entitlements that lived behind that folder are gone with it: SSO, the
  admin surface, multiple workspaces, the workspace spend cap and per-model
  billing. Any of them that Colonie wants later is owned work in core, not a
  folder to restore.
- The *open-source edition boots without an enterprise layer* CI job proves the
  boot response and the absent adapter factory. It does not exercise hosted
  HTTP routes, which no longer exist here.

Upstream's open-core routing rule no longer applies. New work goes in core.

## Contributions

- Contribute under Apache 2.0. No DCO sign-off and no CLA are required. Submit
  only code you wrote or have the right to contribute.
- The edition hook, the cloud seam and this file are covered by
  [`CODEOWNERS`](.github/CODEOWNERS): a maintainer reviews changes there.

## Third-party components and trademarks

Bundled third-party software keeps its own licenses; notices, license texts,
source locations and the SBOM are listed in [NOTICE](NOTICE) and
[`third_party/`](third_party/). The Bloub mascot engine this fork builds its
artwork on is MIT; its notice and provenance travel with the packaged app.

The upstream project's name and mascot are trademarks of Supamaus Software
Private Limited; the Apache License does not grant trademark rights (section 6).
Colonie has its own name and its own Bloub-based mascot, and ships upstream's
`LICENSE` and `NOTICE` unchanged.
