import {gatewayMethod, remoteApp, remoteMethod} from "./base/app-decorators.js";
import PQueue from "p-queue";
import CallablePlugin from "./base/callable-plugin.js";
import AppManager from "./app-manager.js";
import NodeManagerPlugin from "./node-manager.js";
import * as NetworkIpc from "../../network/ipc.js";
import {AppContext, MuonNodeInfo, NetConfigs} from "../../common/types";
import TssPlugin from "./tss-plugin.js";
import {getTimestamp, timeout} from "../../utils/helpers.js";
import {logger} from '@libp2p/logger'
import {MapOf} from "../../common/mpc/types";
import AppContextModel from "../../common/db-models/app-context.js";
import AppTssConfigModel from "../../common/db-models/app-tss-config.js";
import * as CoreIpc from "../ipc.js";
import axios, {AxiosInstance} from "axios";
import _ from 'lodash';
import {muonSha3} from "../../utils/sha3.js";
import * as crypto from "../../utils/crypto.js";

const CONCURRENT_TSS_RECOVERY = 5;
const log = logger("muon:core:plugins:synchronizer")

const RemoteMethods = {
  GetAllContexts: "get-all-ctx",
  IsSeedsRotated: "is-seeds-rotated"
}

@remoteApp
export default class DbSynchronizer extends CallablePlugin {
  private readonly recoveryQueue: PQueue;
  private readonly apis: AxiosInstance[];

  constructor(muon, configs) {
    super(muon, configs)

    this.recoveryQueue = new PQueue({
      concurrency: CONCURRENT_TSS_RECOVERY,
    });

    const netConfigs: NetConfigs = muon.configs.net as NetConfigs;
    if(netConfigs.synchronizer) {
      this.apis = netConfigs.synchronizer.monitor.providers.map((baseUrl) =>
        axios.create({
          baseURL: baseUrl,
          responseType: "json",
          timeout: 5000,
        })
      );
    }
  }

  async onStart(): Promise<void> {
    await super.onStart();
    if(this.muon.configs.net.synchronizer) {
      log('onStart done.')

      /**
       When cluster mode is enabled, there are multiple core processes running simultaneously, which can cause problems.
       Therefore, only one core process should be allowed to handle the database synchronization.
       */
      let permitted = await NetworkIpc.askClusterPermission('db-synchronizer', 20000)
      if (permitted) {
        this.startMonitoring().catch(e => {});
      }
      else {
        log(`process pid:${process.pid} not permitted to synchronize db.`)
      }
    }
  }

  private get nodeManager(): NodeManagerPlugin {
    return this.muon.getPlugin('node-manager');
  }

  private get appManager(): AppManager {
    return this.muon.getPlugin('app-manager');
  }

  private get tssPlugin(): TssPlugin {
    return this.muon.getPlugin('tss-plugin')
  }

  private async startMonitoring() {
    const {monitor: {startDelay, interval}} = this.muon.configs.net.synchronizer;
    log(`monitor start %o`, {startDelay, interval})

    await timeout(Math.floor((0.5 + Math.random()) * startDelay));
    while (true) {
      /**
       * Find missing context
       * Recover missing keys
       * */
      try {
        await this.syncContextsAndKeys()
      }catch (e) {
        log.error(`error when syncing context: ${e.message} %o`, e);
      }

      /**
       * Remove expired context and keys.
       */
      try {
        await this.purgeContextAndKeys()
      }catch (e) {
        log.error(`error when purging context: ${e.message} %o`, e);
      }

      await timeout(interval);
    }
  }

  private async syncContextsAndKeys() {
    log(`syncing contexts and keys ...`)
    let deployers: string[] = this.nodeManager
      .filterNodes({isDeployer: true, excludeSelf: true})
      .map(({id}) => id)

    let contextToSave:AppContext[] = [];
    const fromTimestamp: number = this.appManager.getLastContextTime()

    const isNewContext:boolean = await this.checkNewContext(fromTimestamp);
    if(isNewContext) {
      let onlineDeployers: string[] = await NetworkIpc.findNOnlinePeer(deployers, 2, {timeout: 4000, return: "peerId"})
      log(`query deployers for missing contexts %o`, {onlineDeployers, fromTimestamp})
      // @ts-ignore
      let allContexts: AppContext[] = await Promise.any(
        onlineDeployers.map(deployer => {
          return this.remoteCall(
            deployer,
            RemoteMethods.GetAllContexts,
            {fromTimestamp}
          )
        })
      )

      contextToSave = allContexts.filter(ctx => {
        return !this.appManager.hasContext(ctx)
      })
    }

    log(`there is ${contextToSave.length} missing contexts: %o`, contextToSave.map(ctx => ctx.seed))

    /** Before saving the missing contexts, find the contexts that have no tss key. */
    let contextsWithoutKey: AppContext[] = this.appManager.contextsWithoutKey()
    log(`there is ${contextsWithoutKey.length} contexts without a key: %o`, contextToSave.map(ctx => ctx.seed))

    if(contextToSave.length === 0 && contextsWithoutKey.length === 0)
      return ;

    /** Save all new contexts */
    for(const ctx of contextToSave) {
      await this.appManager.saveAppContext(ctx);
    }

    /** Wait for event propagation */
    await timeout(2000)

    /** Recover app's tss keys */
    log(`starting ${contextToSave.length+contextsWithoutKey.length} tss key recovery ...`)
    await Promise.all([...contextsWithoutKey, ...contextToSave].map(ctx => {
      return this.recoveryQueue.add(() => this.tryTssRecovery(ctx))
    }))
    log(`all ${contextToSave.length+contextsWithoutKey.length} tss key recovery done.`)
  }

  private async checkNewContext(lastContextTimestamp: number): Promise<boolean> {
    log(`checking providers for missing contexts from timestamp ${lastContextTimestamp} ...`)

    /** prepare request data */
    const timestamp = getTimestamp();
    const wallet = process.env.SIGN_WALLET_ADDRESS
    const hash = muonSha3(
      { type: "uint64", value: timestamp },
      { type: "address", value: wallet },
      { type: "string", value: `give me my last context time` }
    );
    const signature = crypto.sign(hash);

    /** get app status from providers */
    const apis:AxiosInstance[] = _.shuffle(this.apis).slice(0,2)
    // @ts-ignore
    const res:{timestamp: number|null} = await Promise.any(
      apis.map(api => {
        return api.post("/last-context-time", {timestamp, wallet, signature})
          .then(({data}) => data)
          .catch(e => {
            log.error("%o", e.message)
            throw e;
          })
      })
    )
      .catch(e => ({timestamp: null}))

    let result: boolean = res.timestamp !== null && res.timestamp > lastContextTimestamp;
    log(result ? `there is some missing context %o`:`there is no missing context %o`, res);
    return result;
  }

  /**
   * Remove expired contexts and corresponding keys.
   * All contexts that are not rotated, should be preserved. This contexts required for rotate and re-share.
   */
  private async purgeContextAndKeys() {
    /** Get all local contexts that expired */
    let expiredContexts:AppContext[] = this.appManager.getAllExpiredContexts();
    log(`there is ${expiredContexts.length} expired context`)
    /**
     * This map shows each context rotated to which context.
     * seed => seed
     */
    let contextIsRotated: MapOf<string> = this.appManager.getContextRotateMap();

    const seedsToDelete: string[] = []
    const seedsToCheck: string[] = []

    for(const ctx of expiredContexts) {
      const {seed} = ctx;
      if(contextIsRotated[seed])
        /** If a context rotated and next context is exist, so we dont need it (the old one) any more. */
        seedsToDelete.push(seed);
      else
        /** If a rotated version of a context not found locally, it need to check it by deployers. */
        seedsToCheck.push(seed);
    }
    log(`there is ${seedsToCheck.length} context that is not rotated.`)
    if(seedsToCheck.length > 0) {
      const seedsRotated: boolean[] = await this.isSeedsRotated(seedsToCheck);
      for (const [i, seed] of seedsToCheck.entries()) {
        /** If a rotated version found on deployers, this context should be remover. */
        if (seedsRotated[i])
          seedsToDelete.push(seed);
      }
    }

    await AppContextModel.deleteMany({
      $or: [
        /** for backward compatibility. old keys may not have this field. */
        {seed: { "$exists" : false }},
        {seed: {$in: seedsToDelete}},
      ]
    });

    await AppTssConfigModel.deleteMany({
      $or: [
        /** for backward compatibility. old keys may not have this field. */
        {seed: { "$exists" : false }},
        {seed: {$in: seedsToDelete}},
      ]
    });
    log(`deleting ${seedsToDelete.length} expired contexts from memory of all cluster`)
    const deleteContextList: AppContext[] = expiredContexts.filter(({seed}) => seedsToDelete.includes(seed))
    CoreIpc.fireEvent({type: "app-context:delete", data: {contexts: deleteContextList}})
    NetworkIpc.fireEvent({type: "app-context:delete", data: {contexts: deleteContextList}})
  }

  private async isSeedsRotated(seeds: string[]): Promise<boolean[]> {
    const currentNode: MuonNodeInfo = this.nodeManager.currentNodeInfo!;
    if(currentNode.isDeployer) {
      return this.__isSeedsRotated({seeds})
    }
    else {
      log(`query deployers to find if seeds are rotated or not ...`)
      let deployersList: string[] = this.nodeManager.filterNodes({isDeployer: true}).map(({id}) => id);
      let peerIds = await NetworkIpc.findNOnlinePeer(deployersList, 2, {timeout: 5000, return: "peerId"});
      // @ts-ignore
      return Promise.any(
        peerIds.map(peerId => {
          return this.remoteCall(
            peerId,
            RemoteMethods.IsSeedsRotated,
            {seeds}
          )
        })
      )
    }
  }

  async tryTssRecovery(ctx: AppContext) {
    log(`starting key recovery app: ${ctx.appName}:${ctx.seed}`)
    const {appId, seed} = ctx
    for(let numTry=3 ; numTry > 0 ; numTry--) {
      await timeout(10000);
      try {
        const recovered = await this.tssPlugin.checkAppTssKeyRecovery(appId, seed, true);
        if(recovered) {
          log(`tss key for app: ${ctx.appName}:${ctx.seed} recovered successfully.`)
          break;
        }
      }
      catch (e) {
        log.error(`error when recovering tss key for app: ${ctx.appName}:${ctx.seed}. %O`, e)
      }
    }
  }

  /**
   * gets a list of seeds to be excluded and return all context excerpt excludeds.
   * @param data
   * @param callerInfo
   * @private
   */
  @remoteMethod(RemoteMethods.GetAllContexts)
  async __getAllContexts(data: {fromTimestamp?: number}={}, callerInfo: MuonNodeInfo): Promise<AppContext[]> {
    let {fromTimestamp=0} = data;
    let allContexts:AppContext[] = this.appManager.getNodeAllContexts(callerInfo)
    /** filter out deployment context or context lower than fromTimestamp */
    allContexts = allContexts.filter(ctx => {
      return ctx.appId !== "1" && ctx.deploymentRequest!.data.timestamp > fromTimestamp!
    });
    return allContexts
  }

  @remoteMethod(RemoteMethods.IsSeedsRotated)
  async __isSeedsRotated(data: {seeds: string[]}): Promise<boolean[]> {
    const {seeds} = data;
    const rotatedSeed = this.appManager.getContextRotateMap()
    return seeds.map(seed => !!rotatedSeed[seed]);
  }
}