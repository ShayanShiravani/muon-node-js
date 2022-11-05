import CallablePlugin from './base/callable-plugin'
import {remoteApp, remoteMethod, appApiMethod} from './base/app-decorators'
import CollateralInfoPlugin from "./collateral-info";
import TssPlugin from "./tss-plugin";
import {AppDeploymentStatus, MuonNodeInfo} from "../../common/types";
const soliditySha3 = require('../../utils/soliditySha3');
const AppContext = require("../../common/db-models/AppContext")
const AppTssConfig = require("../../common/db-models/AppTssConfig")
import * as NetworkIpc from '../../network/ipc'
import DistributedKey from "./tss-plugin/distributed-key";
import AppManager from "./app-manager";
const { timeout } = require('../../utils/helpers')
const { promisify } = require("util");

const RemoteMethods = {
  InformAppDeployed: "informAppDeployed",
  GenerateAppTss: "generateAppTss",
}

@remoteApp
class System extends CallablePlugin {
  APP_NAME = 'system'

  get collateralPlugin(): CollateralInfoPlugin {
    return this.muon.getPlugin('collateral');
  }

  get tssPlugin(): TssPlugin{
    return this.muon.getPlugin('tss-plugin');
  }

  get appManager(): AppManager{
    return this.muon.getPlugin('app-manager');
  }

  getAvailableNodes(): MuonNodeInfo[] {
    const peerIds = Object.keys(this.tssPlugin.availablePeers)
    const currentNodeInfo = this.collateralPlugin.getNodeInfo(process.env.PEER_ID!)
    return [
      currentNodeInfo!,
      ...peerIds.map(peerId => {
        return this.collateralPlugin.getNodeInfo(peerId)!
      })
    ]
  }

  @appApiMethod()
  getNetworkInfo() {
    return {
      tssThreshold: this.collateralPlugin.networkInfo?.tssThreshold!,
      maxGroupSize: this.collateralPlugin.networkInfo?.maxGroupSize!,
    }
  }

  @appApiMethod({})
  selectRandomNodes(seed, t, n): MuonNodeInfo[] {
    const availableNodes = this.getAvailableNodes();
    if(availableNodes.length < t)
      throw `No enough nodes to select n subset`
    let nodesHash = availableNodes.map(node => {
      return {
        node,
        hash: soliditySha3([
          {t: 'uint256', v: seed},
          {t: 'uint64', v: node.id},
        ])
      }
    });
    nodesHash.sort((a, b) => (a.hash > b.hash ? 1 : -1))
    return nodesHash.slice(0, n).map(i => i.node)
  }

  getAppTssKeyId(appId, seed) {
    return `app-${appId}-tss-${seed}`
  }

  @appApiMethod({})
  async getAppStatus(appId: string): Promise<AppDeploymentStatus> {
    if(!this.appManager.appIsDeployed(appId))
      return {appId, deployed: false}
    if(!this.appManager.appHasTssKey(appId))
      return {appId, deployed: true, version: -1}
    const context = this.appManager.getAppContext(appId)
    return {
      appId,
      deployed: true,
      version: context.version,
      reqId: context.deploymentRequest.reqId,
    }
  }

  @appApiMethod({})
  async genAppTss(appId) {
    const context = this.appManager.getAppContext(appId);
    if(!context)
      throw `App deployment info not found.`
    const generatorInfo = this.collateralPlugin.getNodeInfo(context.party.partners[0])!
    if(generatorInfo.wallet === process.env.SIGN_WALLET_ADDRESS){
      return await this.__generateAppTss({appId}, null);
    }
    else {
      // TODO: if nodeInfo not exist of partner is not online?
      return await this.remoteCall(
        generatorInfo.peerId,
        RemoteMethods.GenerateAppTss,
        {appId}
      )
    }
  }

  @appApiMethod({})
  async getAppTss(appId) {
    const context = await AppContext.findOne({appId}).exec();
    if(!context)
      throw `App deployment info not found.`
    const id = this.getAppTssKeyId(appId, context.seed)
    let key = this.tssPlugin.getSharedKey(id)
    return key
  }

  async writeAppContextIntoDb(request, result) {
    let {appId, seed} = request.data.params
    const partners = result.selectedNodes
    const version = 0;
    const deployTime = request.confirmedAt * 1000

    await AppContext.findOneAndUpdate({
      version,
      appId,
    },{
      version, // TODO: version definition
      appId,
      appName: this.muon.getAppNameById(appId),
      isBuiltIn: this.appManager.appIsBuiltIn(appId),
      seed,
      party: {
        t: result.tssThreshold,
        max: result.maxGroupSize,
        partners
      },
      deploymentRequest: request,
      deployTime
    },{
      upsert: true,
      useFindAndModify: false,
    })

    return true
  }

  @appApiMethod({})
  async storeAppContext(request, result) {
    let {appId, seed} = request.data.params
    const partners = result.selectedNodes
    const context = await this.writeAppContextIntoDb(request, result);
    const allOnlineNodes = Object.values(this.tssPlugin.tssParty?.onlinePartners!);

    let requestNonce: DistributedKey = this.tssPlugin.getSharedKey(request.reqId)!

    if(request.owner === process.env.SIGN_WALLET_ADDRESS){

      const noncePartners = requestNonce.partners
      const noneInformedPartners = allOnlineNodes.filter(node => (noncePartners.indexOf(node.id) < 0))

      const informResponses = await Promise.all(noneInformedPartners.map(node => {
        if(node.wallet === process.env.SIGN_WALLET_ADDRESS)
          return "OK";
        // else
        return this.remoteCall(
          node.peerId,
          RemoteMethods.InformAppDeployed,
          request,
        )
          .catch(e => {
            console.log(`System.storeAppContext`, e)
            return 'error'
          })
      }));
    }

    // console.log(context);
    return true;
  }

  @appApiMethod({})
  async storeAppTss(appId) {
    // console.log(`System.storeAppTss`, {appId})

    /** check context exist */
    const context = await AppContext.findOne({appId}).exec();
    if(!context)
      throw `App deployment info not found.`

    /** check key not created before */
    const oldTssKey = await AppTssConfig.findOne({
      appId: appId,
      version: context.version,
    }).exec();
    if(oldTssKey)
      throw `App tss key already generated`

    /** store tss key */
    const id = this.getAppTssKeyId(appId, context.seed);
    let key: DistributedKey = this.tssPlugin.getSharedKey(id)!
    const tssConfig = new AppTssConfig({
      version: context.version,
      appId: appId,
      publicKey: {
        address: key.address,
        encoded: '0x' + key.publicKey?.encodeCompressed('hex'),
        x: '0x' + key.publicKey?.getX().toBuffer('be',32).toString('hex'),
        yParity: key.publicKey?.getY().isEven() ? 0 : 1,
      },
      keyShare: key.share?.toBuffer('be', 32).toString('hex'),
    })
    await tssConfig.save();
    // console.log(key)
  }

  @appApiMethod({})
  async getAppContext(appId) {
    let contexts = await AppContext.find({
      appId
    });
    return contexts[0]
  }

  /**
   * Remote methods
   */

  @remoteMethod(RemoteMethods.InformAppDeployed)
  async __informAppDeployed(request, callerInfo) {
    const {app, method} = request
    if(app !== 'deployment' || method !== 'deploy') {
      console.log("==== request ====", request);
      throw `Invalid deployment request`
    }

    const developmentApp = this.muon.getAppByName("deployment")
    await developmentApp.verifyRequestSignature(request);

    await this.writeAppContextIntoDb(request, request.data.result);

    return "OK"
  }

  @remoteMethod(RemoteMethods.GenerateAppTss)
  async __generateAppTss({appId}, callerInfo) {
    // console.log(`System.__generateAppTss`, {appId});

    const context = await AppContext.findOne({appId}).exec();
    if(!context)
      throw `App deployment info not found.`
    const oldTssKey = await AppTssConfig.findOne({
      appId: context.appId,
      version: context.version
    }).exec();
    if(oldTssKey)
      throw `App tss key already generated`
    const partyId = this.tssPlugin.getAppPartyId(context.appId, context.version)

    await this.tssPlugin.createParty({
      id: partyId,
      t: this.tssPlugin.TSS_THRESHOLD,
      partners: context.party.partners.map(wallet => this.collateralPlugin.getNodeInfo(wallet))
    });
    let party = this.tssPlugin.parties[partyId];
    if(!party)
      throw `Party not created`

    let key = await this.tssPlugin.keyGen(party, {id: this.getAppTssKeyId(appId, context.seed)})

    return {
      address: key.address,
      encoded: key.publicKey?.encodeCompressed("hex"),
      x: key.publicKey?.getX().toBuffer('be', 32).toString('hex'),
      yParity: key.publicKey?.getY().isEven() ? 0 : 1
    }
  }
}

export default System