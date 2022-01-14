import {readdir, rm, cp, readFile, writeFile, copyFile, mkdir} from "fs/promises";
import {join as pathJoin} from "path";
import chalk from "chalk";
import {cloneConfig, runPlatformIO} from "./system";
import {BuildSchema} from "./prepare";

export async function processBuild(buildName: string, build: BuildSchema, kind: "stable" | "nightly", tagOrSha: string) {
    try {
        await rm("./dist/current_build", {recursive: true, force: true});
    } catch (_e) {} // eslint-disable-line
    await cp(`./dist/marlin_${kind}`, "./dist/current_build", {recursive: true});

    const repo = build.based_on.repo.replace("{{marlin_version}}", tagOrSha).replace("{{releaseType}}", kind);
    const configPath = build.based_on.path.replace("{{marlin_version}}", tagOrSha).replace("{{releaseType}}", kind);
    let branch;
    if (kind === "stable") {
        branch = build.based_on.stable_branch.replace("{{marlin_version}}", tagOrSha).replace("{{releaseType}}", kind);
    } else {
        branch = build.based_on.nightly_branch.replace("{{marlin_version}}", tagOrSha).replace("{{releaseType}}", kind);
    }
    await cloneConfig(repo, branch, configPath);

    const configuration = (await readFile("./dist/current_build/Marlin/Configuration.h", "utf8")).split("\n");
    updateConfiguration(configuration, build.configuration);
    await writeFile("./dist/current_build/Marlin/Configuration.h", configuration.join("\n"));

    const configurationAdv = (await readFile("./dist/current_build/Marlin/Configuration_adv.h", "utf8")).split("\n");
    updateConfiguration(configurationAdv, build.configuration_adv);
    await writeFile("./dist/current_build/Marlin/Configuration_adv.h", configurationAdv.join("\n"));

    await runPlatformIO(build.board_env);

    const firmware = (await readdir(`./dist/current_build/.pio/build/${build.board_env}`)).find(f => f.includes("firmware-") && f.includes(".bin"));
    if (!firmware) {
        throw new Error("Failed to build firmware");
    }
    const firmwarePath = `./dist/current_build/.pio/build/${build.board_env}/${firmware}`;
    await copyFile(firmwarePath, `./dist/assets/${firmware}`);

    //save the autogenerated configs
    const configDir = pathJoin(buildName.replace("builds", "autogeneratedConfigs").replace(".js", ""), kind, tagOrSha);
    await mkdir(configDir, {recursive: true});
    await writeFile(pathJoin(configDir, "Configuration.h"), configuration.join("\n"));
    await writeFile(pathJoin(configDir, "Configuration_adv.h"), configurationAdv.join("\n"));
    //also make a copy on a "latest" folder
    const latestConfigDir = pathJoin(buildName.replace("builds", "autogeneratedConfigs").replace(".js", ""), kind, "latest");
    await mkdir(latestConfigDir, {recursive: true});
    await writeFile(pathJoin(latestConfigDir, "Configuration.h"), configuration.join("\n"));
    await writeFile(pathJoin(latestConfigDir, "Configuration_adv.h"), configurationAdv.join("\n"));

    return `./dist/assets/${firmware}`;
}

function updateConfiguration(configuration: string[], updates: BuildSchema["configuration"]) {
    const appliedEnablements: string[] = [];
    const appliedDisablements: string[] = [];
    let inComment = false;
    for (const [index, line] of configuration.entries()) {
        if (line.includes("/*")) {
            inComment = true;
            continue;
        }
        if (line.includes("*/")) {
            inComment = false;
            continue;
        }
        if (inComment) {
            continue;
        }
        for (const enablement of updates.enable) {
            if (typeof enablement === "string" && line.includes(`#define ${enablement}`)) {
                configuration[index] = `${originalIndent(line)}#define ${enablement} //ORIGINAL: ${line}`;
                appliedEnablements.push(enablement);
            } else if (Array.isArray(enablement) && line.includes(`#define ${enablement[0]}`)) {
                let formattedEnabledMent;
                if (typeof enablement[1] === "string") {
                    if (enablement[1].includes("__quote__:")) {
                        formattedEnabledMent = enablement[1].split(":")[1];
                    } else {
                        formattedEnabledMent = `"${enablement[1]}"`;
                    }
                } else if (Array.isArray(enablement[1])) {
                    formattedEnabledMent = formatArrays(enablement[1]);
                } else {
                    formattedEnabledMent = enablement[1];
                }
                configuration[index] = `${originalIndent(line)}#define ${enablement[0]} ${formattedEnabledMent} //ORIGINAL: ${line}`;
                appliedEnablements.push(enablement[0]);
            }
        }
        for (const disablement of updates.disable) {
            if (line.includes(`#define ${disablement}`)) {
                configuration[index] = `${originalIndent(line)}// ${line} //ORIGINAL: ${line}`;
                appliedDisablements.push(disablement);
            }
        }
    }
    printWarnings(updates, appliedEnablements, appliedDisablements);
}

function formatArrays(arr: unknown[]) {
    for (const [index, member] of arr.entries()) {
        if (Array.isArray(member)) {
            arr[index] = formatArrays(member);
        } else if (typeof member === "string") {
            if (member.includes("__quote__:")) {
                arr[index] = member.split(":")[1];
            } else {
                arr[index] = `"${member}"`;
            }
        } else {
            arr[index] = member;
        }
    }
    return `{ ${arr.join(", ")} }`;
}

function originalIndent(line: string) {
    const s = line.match(/^\s+/);
    if (!s) return "";
    return s[0];
}

//print some warnings if any options were applied more than once or not found
function printWarnings(updates: BuildSchema["configuration"], appliedEnablements: string[], appliedDisablements: string[]) {
    if (updates.enable.length > appliedEnablements.length) {
        console.warn(chalk.yellow("The following options were not found in the configuration files. You might want to check for typos or invalid/deprecated names."));
        updates.enable.filter(function(u) {
            if (Array.isArray(u)) {
                return !appliedEnablements.includes(u[0]);
            } else {
                return !appliedEnablements.includes(u);
            }
        }).map(u => console.warn(Array.isArray(u) ? `"${u[0]}"`: `"${u}"`));
    } else if (updates.enable.length < appliedEnablements.length) {
        console.warn(chalk.yellow("The following options were enabled in more than one place. You might want to check the configurations to make sure this is ok."));
        for (const [k, v] of appliedEnablements.reduce((acc, curr) => acc.set(curr, (acc.get(curr) || 0) + 1), new Map<string, number>()).entries()) {
            if (v > 1) console.warn(`"${k}"`);
        }
    }
    if (updates.disable.length > appliedDisablements.length) {
        console.warn(chalk.yellow("The following options were not found in the configuration files. You might want to check for typos or invalid/deprecated names."));
        updates.disable.filter((u) => !appliedDisablements.includes(u)).map(u => console.warn(`"${u}"`));
    } else if (updates.disable.length < appliedDisablements.length) {
        console.warn(chalk.yellow("The following options were disabled in more than one place. You might want to check the configurations to make sure this is ok."));
        for (const [k, v] of appliedDisablements.reduce((acc, curr) => acc.set(curr, (acc.get(curr) || 0) + 1), new Map<string, number>()).entries()) {
            if (v > 1) console.warn(`"${k}"`);
        }
    }
}