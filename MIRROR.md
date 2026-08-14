# ReviewRouter Git Source Mirror

`777genius/ar` is an immutable Git source for ReviewRouter builds. It is not
the publication authority for the `@vioxen/subscription-runtime` package.

- Package releases and GitHub Packages publication belong to
  `vioxen/subscription-runtime`.
- ReviewRouter consumers must pin this mirror by full commit SHA.
- Do not create package-version releases in this repository. Existing tags are
  retained only so already published ReviewRouter releases remain reproducible.
- The copied publish workflows are guarded by the canonical repository identity
  and intentionally skip in this mirror.
