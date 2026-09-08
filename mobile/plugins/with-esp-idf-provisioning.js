const { withSettingsGradle } = require("@expo/config-plugins");

const INCLUDE = `
include ':espIdfProvisioning'
project(':espIdfProvisioning').projectDir = new File(rootProject.projectDir, '../vendor/esp-idf-provisioning-android')
`;

module.exports = function withEspIdfProvisioning(config) {
  return withSettingsGradle(config, (next) => {
    if (next.modResults.language !== "groovy") {
      throw new Error("moodlight provisioning requires Groovy settings.gradle");
    }
    if (!next.modResults.contents.includes("include ':espIdfProvisioning'")) {
      next.modResults.contents = `${next.modResults.contents.trimEnd()}\n${INCLUDE}`;
    }
    return next;
  });
};
