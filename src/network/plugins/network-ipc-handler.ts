import CallablePlugin from './base/callable-plugin'
import {remoteApp, remoteMethod, ipcMethod, broadcastHandler} from './base/app-decorators'
import {IpcCallOptions} from "../../common/types";
import CollateralInfoPlugin from "./collateral-info";
import QueueProducer from "../../common/message-bus/queue-producer";
let requestQueue = new QueueProducer(`gateway-requests`);
const all = require('it-all')
import _ from 'lodash';
import RemoteCall from "./remote-call";

const {timeout} = require('../../utils/helpers')
const {loadCID} = require('../../utils/cid')
const NodeCache = require('node-cache');
const coreIpc = require('../../core/ipc')

const tasksCache = new NodeCache({
  stdTTL: 6 * 60, // Keep distributed keys in memory for 6 minutes
  // /**
  //  * (default: 600)
  //  * The period in seconds, as a number, used for the automatic delete check interval.
  //  * 0 = no periodic check.
  //  */
  checkperiod: 60,
  useClones: false,
});

export const IpcMethods = {
  GetOnlinePeers: "get-online-peers",
  GetCollateralInfo: "get-collateral-info",
  BroadcastMessage: "broadcast-message",
  ReportClusterStatus: "report-cluster-status",
  AskClusterPermission: "ask-cluster-permission",
  AssignTask: "assign-task",
  RemoteCall: "remote-call",
  ContentRoutingProvide: "content-routing-provide",
  ContentRoutingFind: "content-routing-find",
  ForwardGatewayRequest: "forward-gateway-request",
  GetCurrentNodeInfo: "get-current-node-info",
  AllowRemoteCallByShieldNode: "allow-remote-call-by-shield-node",
} as const;

export const RemoteMethods = {
  ExecIpcRemoteCall: "exec-ipc-remote-call",
  ExecGateWayRequest: 'exec-gateway-request',
}

type IpcKeys = keyof typeof IpcMethods;
export type NetworkIpcMethod = typeof IpcMethods[IpcKeys];

@remoteApp
class NetworkIpcHandler extends CallablePlugin {

  clustersPids: { [pid: string]: number } = {};

  async onStart() {
    super.onStart()

    this.network.once('peer:connect', async (peerId) => {
      await timeout(5000);
    })
  }

  get collateralPlugin(): CollateralInfoPlugin {
    return this.network.getPlugin('collateral');
  }

  get remoteCallPlugin(): RemoteCall {
    return this.network.getPlugin('remote-call');
  }

  /**
   * @private
   * @ returns {Promise<string[]>} - list of online peers peerId
   */
  @ipcMethod(IpcMethods.GetOnlinePeers)
  async __onGetOnlinePeers(): Promise<string[]> {
    return Object.keys(this.collateralPlugin.onlinePeers);
  }

  @ipcMethod(IpcMethods.GetCollateralInfo)
  async __onIpcGetCollateralInfo(data = {}, callerInfo) {
    // console.log(`NetworkIpcHandler.__onIpcGetCollateralInfo`, data, callerInfo);
    const collateralPlugin: CollateralInfoPlugin = this.network.getPlugin('collateral');
    await collateralPlugin.waitToLoad();

    let {groupInfo, networkInfo} = collateralPlugin;
    return {
      groupInfo,
      networkInfo,
      nodesList: await collateralPlugin.getNodesList(),
      // nodesList: (await collateralPlugin.getNodesList()).map(item => _.omit(item, ['peer']))
    }
  }

  @ipcMethod(IpcMethods.BroadcastMessage)
  async __onBroadcastMessage(data) {
    // console.log("NetworkIpcHandler.__onBroadcastMessage", data);
    this.broadcast(data);
    return "Ok"
  }

  @broadcastHandler
  async onBroadcastReceived(data={}, callerInfo) {
    // console.log('NetworkIpcHandler.onBroadcastReceived', data, callerInfo);
    return await coreIpc.broadcast({data, callerInfo})
  }

  assignTaskToProcess(taskId: string, pid: number) {
    tasksCache.set(taskId, pid);
  }

  takeRandomProcess(): number {
    let pList = Object.values(this.clustersPids);
    const index = Math.floor(Math.random() * pList.length)
    return pList[index]
  }

  getTaskProcess(taskId: string): number {
    return tasksCache.get(taskId);
  }

  @ipcMethod(IpcMethods.ReportClusterStatus)
  async __reportClusterStatus(data: { pid: number, status: "start" | "exit" }) {
    // console.log("NetworkIpcHandler.__reportClusterStatus", {data,callerInfo});
    let {pid, status} = data
    switch (status) {
      case "start":
        this.clustersPids[pid] = pid
        break;
      case "exit":
        delete this.clustersPids[pid];
        break;
    }
    // console.log("NetworkIpcHandler.__reportClusterStatus", this.clustersPids);
  }

  clusterPermissions = {};

  @ipcMethod(IpcMethods.AskClusterPermission)
  async __askClusterPermission(data, callerInfo) {
    // every 20 seconds one process get permission to do election
    if (
      (!this.clusterPermissions[data?.key])
      || (Date.now() - this.clusterPermissions[data?.key] > data.expireTime)
    ) {
      this.clusterPermissions[data?.key] = Date.now()
      return true
    } else
      return false;
  }

  /**
   * assign a task to caller process
   * @param data
   * @param data.taskId - ID of task for assign to caller
   * @param callerInfo
   * @param callerInfo.pid - process ID of caller
   * @param callerInfo.uid - unique id of call
   * @returns {Promise<string>}
   * @private
   */
  @ipcMethod(IpcMethods.AssignTask)
  async __assignTaskToProcess(data, callerInfo) {
    if (Object.keys(this.clustersPids).length < 1)
      throw {message: "No any online cluster"}
    this.assignTaskToProcess(data?.taskId, callerInfo.pid);
    return 'Ok';
  }

  /**
   *
   * @param data {Object}         - remote call arguments
   * @param data.peer {String}    - PeerID of remote peer
   * @param data.method {String}  - method to call
   * @param data.params {Object}  - remote method arguments
   * @param data.options {Object} - remote call options
   * @returns {Promise<[any]>}
   * @private
   */
  @ipcMethod(IpcMethods.RemoteCall)
  async __onRemoteCallRequest(data) {
    // console.log(`NetworkIpcHandler.__onRemoteCallRequest`, data);
    const peer = await this.findPeer(data?.peer);
    return await this.remoteCall(peer, "exec-ipc-remote-call", data, data?.options);
  }

  @ipcMethod(IpcMethods.ContentRoutingProvide)
  async __onContentRoutingProvide(cids: string[], callerInfo) {
    for (let cid of cids) {
      console.log(`providing content ${cid}`)
      await this.network.libp2p.contentRouting.provide(loadCID(cid));
    }
  }

  @ipcMethod(IpcMethods.ContentRoutingFind)
  async __onContentRoutingFind(cid: string, callerInfo) {
    console.log(`NetworkIpcHandler.__onContentRoutingFind`, cid);
    let providers = await all(this.network.libp2p.contentRouting.findProviders(loadCID(cid), {timeout: 5000}))
    return providers.map(p => p.id._idB58String)
  }

  @ipcMethod(IpcMethods.ForwardGatewayRequest)
  async __forwardGateWayRequest(data: {id: string, requestData: Object}) {
    console.log(`NetworkIpcHandler.__forwardGateWayRequest`, data);
    const nodeInfo = this.collateralPlugin.getNodeInfo(data.id)
    if(!nodeInfo) {
      throw `Unknown id ${data.id}`
    }
    const peer = await this.findPeer(nodeInfo.peerId);
    return await this.remoteCall(peer, RemoteMethods.ExecGateWayRequest, data.requestData);
  }

  @ipcMethod(IpcMethods.GetCurrentNodeInfo)
  async __onGetCurrentNodeInfo() {
    await this.collateralPlugin.waitToLoad();
    return this.collateralPlugin.getNodeInfo(process.env.SIGN_WALLET_ADDRESS!);
  }

  @ipcMethod(IpcMethods.AllowRemoteCallByShieldNode)
  async __allowRemoteCallByShieldNode(data: {method: string, options: any}) {
    this.remoteCallPlugin.allowCallByShieldNode(data.method, data.options)
    return true
  }

  /** ==================== remote methods ===========================*/


  /**
   *
   * @param data {Object}
   * @param data.peer {string}
   * @param data.method {string}
   * @param data.params {Object}
   * @param data.options {Object}
   * @param data.options.timeout {number}
   * @param data.options.timeoutMessage {string}
   * @param data.options.taskId {string}
   * @param callerInfo
   * @returns {Promise<*>}
   * @private
   */
  @remoteMethod(RemoteMethods.ExecIpcRemoteCall)
  async __onIpcRemoteCallExec(data, callerInfo) {
    // console.log(`NetworkIpcHandler.__onIpcRemoteCallExec`, data);
    let taskId, options: IpcCallOptions = {};
    if (data?.options?.taskId) {
      taskId = data?.options.taskId;
      if (tasksCache.has(taskId)) {
        options.pid = tasksCache.get(data.options.taskId);
      } else {
        options.pid = this.takeRandomProcess()
        this.assignTaskToProcess(taskId, options.pid);
      }
    }
    return await coreIpc.forwardRemoteCall(data, _.omit(callerInfo, ['peer']), options);
  }

  @remoteMethod(RemoteMethods.ExecGateWayRequest)
  async __execGatewayRequest(data, callerInfo) {
    // console.log(`NetworkIpcHandler.__execGatewayRequest`, data)
    return await requestQueue.send(data)
  }
}

export default NetworkIpcHandler;
