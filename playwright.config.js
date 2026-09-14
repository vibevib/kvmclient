// e2e config: these drive a real Electron app, so run them serially.
module.exports = {
  testDir: './tests',
  timeout: 60000,
  expect: { timeout: 15000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list']]
};
