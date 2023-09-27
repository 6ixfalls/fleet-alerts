import * as k8s from "@kubernetes/client-node";
import { Octokit, App } from "octokit";
import logger from "./logger.js";

const kc = new k8s.KubeConfig();
kc.loadFromDefault();
const k8sApi = kc.makeApiClient(k8s.CustomObjectsApi);

const apiVersion = process.env.API_VERSION || "fleet.cattle.io/v1alpha1";
const group = apiVersion.split("/")[0];
const version = apiVersion.split("/")[1];

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

informer.on("add", async (obj) => {
    logger.info(`BundleDeployment ${obj.metadata?.name} added`);
    logger.info(obj);
});

informer.on("update", async (obj) => {
    logger.info(`BundleDeployment ${obj.metadata?.name} updated`);
    logger.info(obj);
});

informer.on("delete", async (obj) => {
    logger.info(`BundleDeployment ${obj.metadata?.name} deleted`);
    logger.info(obj);
});

informer.on("error", (err) => {
    logger.error(err);
    setTimeout(() => {
        informer.start();
    }, 10000);
});

informer.start();
