# ReviewRouter Git Source Mirror

`777genius/ar` is an open-source Git mirror for reproducible runtime builds. It
is not the package-registry publication authority for
`@vioxen/subscription-runtime`.

- Package releases and GitHub Packages publication belong to
  `vioxen/subscription-runtime`.
- Consumers must pin this mirror by full commit SHA and build that source.
- Do not create package-version releases in this repository. Existing tags are
  retained only so already published ReviewRouter releases remain reproducible.
- The copied publish workflows are guarded by the canonical repository identity
  and intentionally skip in this mirror.
