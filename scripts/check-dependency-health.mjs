import fs from "node:fs";
import path from "node:path";

const lockPath = path.join(process.cwd(), "package-lock.json");
const lock = JSON.parse(fs.readFileSync(lockPath, "utf8"));
const packages = lock.packages ?? {};
const deprecated = Object.entries(packages)
  .filter(([, metadata]) => metadata && typeof metadata.deprecated === "string")
  .map(([location, metadata]) => ({
    location: location || "(root)",
    version: metadata.version ?? "unknown",
    message: metadata.deprecated.replace(/\s+/g, " ").trim(),
  }))
  .sort((a, b) => a.location.localeCompare(b.location));

const escapeMarkdown = (value) =>
  String(value).replaceAll("|", "\\|").replaceAll("\n", " ");

console.log(
  `Dependency health: ${deprecated.length} deprecated package entries in package-lock.json`,
);

for (const entry of deprecated) {
  console.log(`- ${entry.location}@${entry.version}: ${entry.message}`);
}

const summaryPath = process.env.GITHUB_STEP_SUMMARY;
if (summaryPath) {
  const summary = [
    "## Dependency health",
    "",
    `Deprecated package entries: **${deprecated.length}**`,
    "",
  ];

  if (deprecated.length > 0) {
    summary.push(
      "| Lockfile location | Version | Package notice |",
      "| --- | ---: | --- |",
      ...deprecated.map(
        (entry) =>
          `| \`${escapeMarkdown(entry.location)}\` | ${escapeMarkdown(entry.version)} | ${escapeMarkdown(entry.message)} |`,
      ),
    );
  } else {
    summary.push("No deprecated package metadata found.");
  }

  fs.appendFileSync(summaryPath, `${summary.join("\n")}\n`);
}

if (process.env.GITHUB_ACTIONS === "true" && deprecated.length > 0) {
  console.log(
    `::warning::${deprecated.length} deprecated package entries remain; see the Dependency health job summary for dependency paths and disposition.`,
  );
}

if (process.argv.includes("--fail-on-deprecated") && deprecated.length > 0) {
  process.exitCode = 1;
}
