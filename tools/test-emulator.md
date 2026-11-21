The test database: `firebase.test.json` in the repo root (Firebase refuses a rules file outside the
config's folder). A second Firestore emulator on port 8181, used only by the tests (the tracker and
`FIRESTORE_EMULATOR_HOST=127.0.0.1:8181 npm test`). Tests wipe the database they run against, so they
never use the 8080 emulator, which holds the local test chats. `npm run dev` starts both.
