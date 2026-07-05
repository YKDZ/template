# @ykdz/template

Project template generator for YKDZ starter projects.

## Usage

```sh
pnpm dlx @ykdz/template init my-project --preset ts-lib --yes
```

Available commands:

```sh
template init <dir> --preset <name> --yes
template add package --preset <name> --name <name> [--path <package-path>]
template presets
template schema preset
template schema blueprint
template preset validate <path>
template blueprint validate <path>
```

Supported presets are `ts-lib`, `hono-api`, `vue-app`, `vue-hono-app`, and
`rust-bin`.

## Publishing

This package is intended to publish through npm Trusted Publishing from the
GitHub Actions release workflow.

## License

MIT
