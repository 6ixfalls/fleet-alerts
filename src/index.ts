import * as k8s from "@kubernetes/client-node";
import { Octokit, App } from "octokit";
import logger from "./logger.js";

const kc = new k8s.KubeConfig();
kc.loadFromDefault();
const k8sApi = kc.makeApiClient(k8s.CustomObjectsApi);

const apiVersion = process.env.API_VERSION || "fleet.cattle.io/v1alpha1";
const group = apiVersion.split("/")[0];
const version = apiVersion.split("/")[1];

const StateMap: {
    [state: string]: {
        state: "error" | "success" | "pending" | "failure";
        description: string;
    };
} = {
    Ready: {
        state: "success",
        description: "Bundle deployment succeeded",
    },
    NotReady: {
        state: "pending",
        description: "Bundle deployment in progress",
    },
    WaitApplied: {
        state: "pending",
        description: "Bundle deployment in progress",
    },
    ErrApplied: {
        state: "error",
        description: "Bundle deployment failed",
    },
    OutOfSync: {
        state: "error",
        description: "Bundle deployment OutOfSync",
    },
    Pending: {
        state: "pending",
        description: "Bundle deployment in progress",
    },
    Modified: {
        state: "success", // failure?
        description: "Bundle deployment modified",
    },
};

const octokit = new Octokit({ auth: process.env.GITHUB_ALERTS_PAT });
const {
    data: { login },
} = await octokit.rest.users.getAuthenticated();
logger.info(`Logged in as ${login}`);

const informer = k8s.makeInformer(
    kc,
    `/apis/${apiVersion}/bundledeployment`,
    () =>
        //@ts-ignore
        k8sApi.listClusterCustomObject(group, version, "bundledeployments")
);

const watch = new k8s.Watch(kc);
const gitRepoRefs: { [name: string]: { user: string; repo: string } } = {};
const request = await watch.watch(
    `/apis/${apiVersion}/gitrepos`,
    {},
    (type, obj) => {
        if (type === "ADDED") {
            const match = obj.spec.repo.match(
                /git@github\.com:(.*)\/(.*)\.git/
            ); // git@github.com:username/repo.git
            gitRepoRefs[obj.metadata.name] = {
                user: match[1],
                repo: match[2],
            };
        } else if (type === "MODIFIED") {
            const match = obj.spec.repo.match(
                /git@github\.com:(.*)\/(.*)\.git/
            );
            gitRepoRefs[obj.metadata.name] = {
                user: match[1],
                repo: match[2],
            };
        } else if (type === "DELETED") {
            delete gitRepoRefs[obj.metadata.name];
        }
    },
    (err) => logger.error(err)
);

async function updateBundleDeployment(
    obj: k8s.KubernetesObject & { [key: string]: any }
) {
    logger.info(`BundleDeployment ${obj.metadata?.name} state changed`);
    if (!obj.metadata || !obj.metadata.labels) {
        logger.error(`BundleDeployment missing metadata`);
        return;
    }
    const gitRepoRef =
        gitRepoRefs[obj.metadata.labels["fleet.cattle.io/repo-name"]];
    if (!gitRepoRef) {
        logger.error(
            `GitRepoRef ${obj.metadata.labels["fleet.cattle.io/repo-name"]} not found`
        );
        return;
    }

    const state = StateMap[obj.status?.state];
    if (!state) {
        logger.error(`Unknown state ${obj.status?.state}`);
        return;
    }

    octokit.rest.repos.createCommitStatus({
        owner: gitRepoRef.user,
        repo: gitRepoRef.repo,
        sha: obj.metadata.labels["fleet.cattle.io/commit"],
        context: obj.metadata.name,
        state: state.state,
        description: state.description,
        target_url:
            process.env.RANCHER_EXPLORER_URL &&
            `${process.env.RANCHER_EXPLORER_URL}/${group}.bundledeployment/${obj.metadata.namespace}/${obj.metadata.name}`,
    });
}

informer.on("add", updateBundleDeployment);

informer.on("update", updateBundleDeployment);

informer.on("delete", async (obj) => {
    logger.info(`BundleDeployment ${obj.metadata?.name} deleted`);
});

informer.on("error", (err) => {
    logger.error(err);
    setTimeout(() => {
        informer.start();
    }, 10000);
});

informer.start();
