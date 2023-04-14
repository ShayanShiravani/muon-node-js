import cluster, {Worker} from 'cluster'
import * as os from 'os'
import axios, {AxiosRequestConfig} from 'axios'
import Log from './common/muon-log.js'
import * as Gateway from './gateway/index.js'
import * as Network from './network/index.js'
import * as Core from './core/index.js'
import * as NetworkIpc from './network/ipc.js'
import * as SharedMemory from './common/shared-memory/index.js'
import { parseBool, timeout } from './utils/helpers.js'
import { createRequire } from "module";
import {muonSha3} from "./utils/sha3.js";
import * as crypto from "./utils/crypto.js";

// const require = createRequire(import.meta.url);
const log = Log('muon:boot')

type ClusterType = 'gateway' | 'networking' | "core"

process.on('unhandledRejection', async function(reason, _promise) {
  // console.log("Unhandled promise rejection", _promise);
  console.dir(reason, {depth: 5})
  const timestamp = Date.now(), wallet = process.env.SIGN_WALLET_ADDRESS

  const reportData:any = {
    timestamp,
    wallet,
    cluster: process.env.MUON_CLUSTER_TYPE || "unknown",
    error: {
      reason,
      // @ts-ignore
      stack: reason?.stack || null,
    },
    signature: "",
  };
  const hash = muonSha3(
    {t: 'uint64', v: timestamp},
    {t: 'address', v: wallet},
    {t: 'string', v: 'crash-report'},
  );
  reportData.signature = crypto.sign(hash)
  console.log("crash report data", reportData)

  const axiosConfigs: AxiosRequestConfig = {
    timeout: 3000
  }
  console.log('reporting crash to muon servers ...')
  const reportResults = await Promise.all([
    axios.post('https://testnet.muon.net/crash-report/report', reportData, axiosConfigs)
      .then(() => "OK")
      .catch(e => "Failed"),
    // axios.post('http://localhost:8001/crash-report/report', reportData, axiosConfigs)
    //   .then(() => "OK")
    //   .catch(e => "Failed"),
  ])
    .catch(e => {})
  console.log(`reporting crash done ${reportResults}.`)
  process.exit(1);
});


let clusterCount = 1;
if(parseBool(process.env.CLUSTER_MODE)) {
  if(process.env.CLUSTER_COUNT) {
    clusterCount = parseInt(process.env.CLUSTER_COUNT);
    clusterCount = Math.max(clusterCount, os.cpus().length)
  }
  else{
    clusterCount = Math.min(os.cpus().length, 2);
  }
}

type ClusterInfo = {type: ClusterType, worker: Worker}
type ApplicationDictionary = {[index: number]: ClusterInfo}

const applicationWorkers:ApplicationDictionary = {};

function runNewApplicationCluster(type: ClusterType): Worker | null {
  const child:Worker = cluster.fork({MUON_CLUSTER_TYPE: type});//{MASTER_PROCESS_ID: process.pid}
  if(!child?.process?.pid){
    log(`application cluster does not start correctly.`)
    return null;
  }
  applicationWorkers[child.process.pid] = {
    type,
    worker: child
  }
  return child;
}

async function refreshWorkersList() {
  // TODO: try to find the process that stopped working and remove it from workers list
}

async function boot() {
  if (cluster.isMaster) {
    log(`Master cluster start at [${process.pid}]`)
    SharedMemory.startServer();

    /** start gateway cluster */
    runNewApplicationCluster('gateway');

    /** start network cluster */
    try {
      await Network.start()
    }
    catch (e) {
      console.log(`Network failed to start.`, e)
      throw e
    }

    /** Start core clusters */
    for (let i = 0; i < clusterCount; i++) {
      const child:Worker|null = runNewApplicationCluster('core');
      if(child === null){
        i--;
        log(`child process fork failed. trying one more time`);
      }else
        await NetworkIpc.reportClusterStatus(child.process.pid, 'start')
    }

    /** restart stopped cluster */
    cluster.on("exit", async function (worker, code, signal) {
      log(`Worker ${worker.process.pid} died with code: ${code}, and signal: ${signal}`);
      let clusterInfo:ClusterInfo;

      if(!worker.process.pid) {
        log(`a worker with an unknown pid stopped working.`)
        await refreshWorkersList();
      }
      else {
        clusterInfo = applicationWorkers[worker.process.pid];
        delete applicationWorkers[worker.process.pid];
        if(clusterInfo.type === 'core') {
          await NetworkIpc.reportClusterStatus(worker.process.pid, 'exit')
        }

        await timeout(5000);
        log(`Starting a new cluster type:${clusterInfo.type}`);
        let child = runNewApplicationCluster(clusterInfo.type);
        if(!child){
          return ;
        }
        if(clusterInfo.type === 'core') {
          await NetworkIpc.reportClusterStatus(child.process.pid, 'start')
        }
      }
    });
  }
  else {
    const clusterType:ClusterType = process.env.MUON_CLUSTER_TYPE! as ClusterType;
    log(`child cluster start type:${clusterType} pid:${process.pid}`)
    // require('./core').start();
    switch (clusterType) {
      case 'gateway': {
        Gateway.start()
          .catch(e => {
            console.log(`Gateway failed to start.`, e)
          })
        break;
      }
      case 'core': {
        Core.start();
        break;
      }
      case 'networking': {
        throw `Networking cluster should start in master cluster`
      }
      default:
        throw `invalid cluster type: ${clusterType}`;
    }
  }

  // Core.start();
}

boot();
