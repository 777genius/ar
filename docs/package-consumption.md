# Package Consumption

Use the published GitHub Packages artifact:

```ini
@vioxen:registry=https://npm.pkg.github.com
```

CI consumers should provide a token with package read access through their
environment, for example `NODE_AUTH_TOKEN` or the job `GITHUB_TOKEN`. Do not
commit package tokens to `.npmrc`.

```bash
npm install @vioxen/subscription-runtime
```

Use the version published by the intended
[GitHub Release](https://github.com/vioxen/subscription-runtime/releases).
Do not copy a version from an arbitrary `main` checkout: the release tag pins
the package manifest and artifact that were actually published.

Production services should commit their lockfile. The lockfile pins the exact
package artifact that was installed. To pull a newer published version:

```bash
npm update @vioxen/subscription-runtime
```

Then rebuild and commit the lockfile.

## Release Source And Mirrors

The package version is the contract consumed by host apps. When a host app needs
new public exports, publish the new `@vioxen/subscription-runtime` version
first, then update the host app dependency and lockfile from the published
artifact.

The preferred release policy is:

- the organization repository is the canonical source for reviewed runtime code;
- mirrors may publish the same commit to GitHub Packages for npm consumption;
- release tags must stay synchronized across the canonical repo and mirror;
- consumers should never pin a floating branch for production dependency
  resolution.
