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

const gitRepoInformer = k8s.makeInformer(
    kc,
    `/apis/${apiVersion}/gitrepos`,
    () =>
        //@ts-ignore
        k8sApi.listClusterCustomObject(group, version, "gitrepos")
);
const gitRepoRefs: { [name: string]: { user: string; repo: string } } = {};

async function updateGitRepos(
    obj: k8s.KubernetesObject & { [key: string]: any }
) {
    if (!obj.metadata || !obj.metadata.name) {
        logger.error(`GitRepo missing metadata`);
        return;
    }
    const match = obj.spec.repo.match(/git@github\.com:(.*)\/(.*)\.git/); // git@github.com:username/repo.git
    gitRepoRefs[obj.metadata.name] = {
        user: match[1],
        repo: match[2],
    };
}
gitRepoInformer.on("add", updateGitRepos);
gitRepoInformer.on("update", updateGitRepos);
gitRepoInformer.on("delete", async (obj) => {
    if (!obj.metadata || !obj.metadata.name) {
        logger.error(`GitRepo missing metadata`);
        return;
    }
    logger.info(`GitRepo ${obj.metadata.name} deleted`);
    delete gitRepoRefs[obj.metadata.name];
});

gitRepoInformer.start();

async function updateBundleDeployment(
    obj: k8s.KubernetesObject & { [key: string]: any }
) {
    if (!obj.metadata || !obj.metadata.labels) {
        logger.error(`BundleDeployment missing metadata`);
        return;
    }
    logger.info(`BundleDeployment ${obj.metadata.name} state changed`);

    const gitRepoRef =
        gitRepoRefs[obj.metadata.labels["fleet.cattle.io/repo-name"]];
    if (!gitRepoRef) {
        logger.error(
            `GitRepoRef ${obj.metadata.labels["fleet.cattle.io/repo-name"]} not found`
        );
        return;
    }

    if (!obj.status || !obj.status.display || !obj.status.display.state) {
        logger.error(`BundleDeployment ${obj.metadata.name} missing status`);
        return;
    }
    const state = StateMap[obj.status.display.state];
    if (!state) {
        logger.error(`Unknown state ${obj.status.display.state}`);
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
