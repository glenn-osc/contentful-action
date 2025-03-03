const core = require("@actions/core");
const github = require("@actions/github");

// most @actions toolkit packages have async methods
async function run() {
  try {
    const { context } = github;
    const { promisify } = require("util");
    const { readdir } = require("fs");
    const readdirAsync = promisify(readdir);
    const path = require("path");
    const { createClient } = require("contentful-management");
    const {
      default: runMigration,
    } = require("contentful-migration/built/bin/cli");

    // utility fns
    const getVersionOfFile = (file) =>
      file.replace(".js", "").replace(/_/g, ".");
    const getFileOfVersion = (version) => version.replace(/\./g, "_") + ".js";

    const getBranchName = () => {
      let { ref } = context;

      if (github.context.eventName === "pull_request") {
        const pullRequestPayload = github.context.payload;
        core.info(`head : ${pullRequestPayload.pull_request.head}`);

        // actual branch name, not something like 'pull/111/merge'
        ref = pullRequestPayload.pull_request.head.ref;
        core.info(
          `The head ref is: ${pullRequestPayload.pull_request.head.ref}`
        );
      }

      return (
        ref
          .replace("refs/heads/", "")
          // normalize git-flow branch names ie. feat/foo-feature -> feat-foo-feature
          .replace(/\//g, "-")
      );
    };

    //
    // Configuration variables
    //
    const SPACE_ID = process.env.SPACE_ID;
    const MANAGEMENT_API_KEY = process.env.MANAGEMENT_API_KEY;

    const ENVIRONMENT_INPUT = getBranchName();

    const DEFAULT_MIGRATIONS_DIR = "migrations";
    const MIGRATIONS_DIR = path.join(
      process.env.GITHUB_WORKSPACE,
      process.env.MIGRATIONS_DIR || DEFAULT_MIGRATIONS_DIR
    );

    const client = createClient({
      accessToken: MANAGEMENT_API_KEY,
    });
    const space = await client.getSpace(SPACE_ID);

    var ENVIRONMENT_ID = "";

    let environment;
    console.log("Running with the following configuration");
    // ---------------------------------------------------------------------------
    if (ENVIRONMENT_INPUT == "main") {
      console.log(`Running on main.`);
      ENVIRONMENT_ID = "master-".concat(getStringDate());
    } else {
      console.log("Running on staging branch");
      ENVIRONMENT_ID = "staging";
    }
    console.log(`ENVIRONMENT_ID: ${ENVIRONMENT_ID}`);

    // ---------------------------------------------------------------------------

    console.log(
      `Checking for existing versions of environment: ${ENVIRONMENT_ID}`
    );

    // try {
    //   environment = await space.getEnvironment(ENVIRONMENT_ID);
    //   if (ENVIRONMENT_ID != "master") {
    //     await environment.delete();
    //     console.log("Environment deleted");
    //   }
    // } catch (e) {
    //   console.log("Environment not found");
    // }

    // ---------------------------------------------------------------------------
    if (ENVIRONMENT_ID.startsWith("master")) {
      console.log(`Creating environment ${ENVIRONMENT_ID}`);
      environment = await space.createEnvironmentWithId(ENVIRONMENT_ID, {
        name: ENVIRONMENT_ID,
      });
    } else if (ENVIRONMENT_ID.startsWith("staging")) {
      environment = await space.getEnvironment(ENVIRONMENT_ID);
    }
    // ---------------------------------------------------------------------------
    const DELAY = 3000;
    const MAX_NUMBER_OF_TRIES = 10;
    let count = 0;

    console.log(`Waiting for environment ${environment.name} processing...`);

    while (count < MAX_NUMBER_OF_TRIES) {
      const status = (await space.getEnvironment(environment.sys.id)).sys.status
        .sys.id;

      if (status === "ready" || status === "failed") {
        if (status === "ready") {
          console.log(
            `Successfully processed new environment (${ENVIRONMENT_ID})`
          );
        } else {
          console.log("Environment creation failed");
        }
        break;
      }

      await new Promise((resolve) => setTimeout(resolve, DELAY));
      count++;
    }

    // ---------------------------------------------------------------------------
    console.log("Update API Keys to allow access to new environment");
    const newEnv = {
      sys: {
        type: "Link",
        linkType: "Environment",
        id: ENVIRONMENT_ID,
      },
    };

    const { items: keys } = await space.getApiKeys();
    await Promise.all(
      keys.map((key) => {
        console.log(`Updating - ${key.sys.id}`);
        key.environments.push(newEnv);
        return key.update();
      })
    );

    // ---------------------------------------------------------------------------
    console.log("Set default locale to new environment");
    const defaultLocale = (await environment.getLocales()).items.find(
      (locale) => locale.default
    ).code;

    // ---------------------------------------------------------------------------
    console.log("Read all the available migrations from the file system");
    const availableMigrations = (await readdirAsync(MIGRATIONS_DIR))
      .filter((file) => /^\d+?\.js$/.test(file))
      .map((file) => getVersionOfFile(file));
    console.log("availableMigrations: ", availableMigrations);

    // ---------------------------------------------------------------------------
    console.log("Figure out latest ran migration of the contentful space");
    let storedVersionEntry = { fields: { version: 0 } };
    try {
      const { items: versions } = await environment.getEntries({
        content_type: "versionTracking",
      });
      console.log("versions: ", versions);

      if (!versions.length || versions.length > 1) {
        throw new Error(
          "There should only be one entry of type 'versionTracking'"
        );
      }

      storedVersionEntry = versions[0];
    } catch (error) {
      console.log("error when get version: ", error);
    }

    const currentVersionString =
      storedVersionEntry.fields.version[defaultLocale];

    // ---------------------------------------------------------------------------
    console.log("Evaluate which migrations to run");
    const currentMigrationIndex =
      availableMigrations.indexOf(currentVersionString);

    if (currentMigrationIndex === -1) {
      throw new Error(
        `Version ${currentVersionString} is not matching with any known migration`
      );
    }
    const migrationsToRun = availableMigrations.slice(
      currentMigrationIndex + 1
    );
    const migrationOptions = {
      spaceId: SPACE_ID,
      environmentId: ENVIRONMENT_ID,
      accessToken: MANAGEMENT_API_KEY,
      yes: true,
    };

    // ---------------------------------------------------------------------------
    console.log("Run migrations and update version entry");
    while ((migrationToRun = migrationsToRun.shift())) {
      const filePath = path.join(
        MIGRATIONS_DIR,
        getFileOfVersion(migrationToRun)
      );
      console.log(`Running ${filePath}`);

      try {
        await runMigration(
          Object.assign(migrationOptions, {
            filePath,
          })
        );
      } catch (error) {
        console.log("MIGRATION ERROR: ", error);
      }
      console.log(`${migrationToRun} succeeded`);

      storedVersionEntry.fields.version[defaultLocale] = migrationToRun;
      storedVersionEntry = await storedVersionEntry.update();
      storedVersionEntry = await storedVersionEntry.publish();

      console.log(`Updated version entry to ${migrationToRun}`);
    }

    // ---------------------------------------------------------------------------
    console.log("Checking if we need to update master alias");
    if (ENVIRONMENT_INPUT == "main") {
      console.log(`Running on master.`);
      console.log(`Updating master alias.`);
      await space
        .getEnvironmentAlias("master")
        .then((alias) => {
          alias.environment.sys.id = ENVIRONMENT_ID;
          return alias.update();
        })
        .then((alias) => console.log(`alias ${alias.sys.id} updated.`))
        .catch(console.error);
      console.log(`Master alias updated.`);
    } else {
      console.log("Running on feature branch");
      console.log("No alias changes required");
    }

    const environmentUrl = `https://app.contentful.com/spaces/${space.sys.id}/environments/${ENVIRONMENT_ID}`;
    const environmentName = ENVIRONMENT_ID;

    core.setOutput("environment_url", environmentUrl);
    core.setOutput("environment_name", environmentName);
    console.log("All done!!!");
  } catch (error) {
    core.setFailed(error.message);
  }
}

run();

function getStringDate() {
  var d = new Date();
  function pad(n) {
    return n < 10 ? "0" + n : n;
  }
  return (
    d.toISOString().substring(0, 10) +
    "-" +
    pad(d.getUTCHours()) +
    pad(d.getUTCMinutes())
  );
}
