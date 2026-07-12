ARG PLAYWRIGHT_CLI_PACKAGE
RUN npx --yes --package "${PLAYWRIGHT_CLI_PACKAGE}" playwright install-deps chromium
