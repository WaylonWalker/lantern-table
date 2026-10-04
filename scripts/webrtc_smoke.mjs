#!/usr/bin/env node
import { execFileSync, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';

const baseUrl = process.env.LANTERN_PUBLIC_URL || 'https://dnd.waylonwalker.com';
const hostSession = `lantern-rtc-host-${randomUUID().slice(0, 8)}`;
const playerSession = `lantern-rtc-player-${randomUUID().slice(0, 8)}`;
const refreshedPlayerSession = `lantern-rtc-refresh-${randomUUID().slice(0, 8)}`;
const room = `SMOKE-${randomUUID().replaceAll('-', '').slice(0, 10).toUpperCase()}`;
const hostPeer = `host-${randomUUID()}`;
const playerPeer = `player-${randomUUID()}`;
const timeoutMs = 45_000;

function browser(session, ...args) {
  return execFileSync('agent-browser', ['--session', session, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 20_000,
  }).trim();
}

function evalIn(session, expression) {
  return browser(session, 'eval', expression);
}

function readState(session) {
  const result = evalIn(session, 'JSON.stringify(window.__lanternRtcSmoke)');
  const parsed = JSON.parse(result);
  return typeof parsed === 'string' ? JSON.parse(parsed) : parsed;
}

async function waitFor(predicate, description) {
  const deadline = Date.now() + timeoutMs;
  let lastState = null;
  while (Date.now() < deadline) {
    lastState = predicate();
    if (lastState?.error) throw new Error(`${description}: ${lastState.error}`);
    if (lastState?.done) return lastState;
    await new Promise((resolve) => setTimeout(resolve, 400));
  }
  throw new Error(`${description} timed out. Last state: ${JSON.stringify(lastState)}`);
}

function startClient(session, role, peerId, remotePeerId = '', sessionId = randomUUID()) {
  const source = `(() => {
    const state = window.__lanternRtcSmoke = {role:${JSON.stringify(role)},room:${JSON.stringify(room)},peer:${JSON.stringify(peerId)},remotePeer:${JSON.stringify(remotePeerId)},sessionId:${JSON.stringify(sessionId)},events:[],candidateTypes:[],candidatePair:null,open:false,pong:false,pongs:0,pings:0,error:null,queuedIce:[]};
    const role=state.role,room=state.room;
    let socket=null,pcRef=null,dcRef=null,iceServers=[];
    const log = (event, detail={}) => state.events.push({event, ...detail});
    const signal = (target, kind, payload={}) => { if (socket?.readyState===WebSocket.OPEN) { const routedTarget=role==='player'&&target!=='*'?'host':target;const wire=JSON.stringify({type:kind,target:routedTarget,payload:{kind,...payload}});socket.send(wire);if(kind==='diagnostic'){state.diagnosticSentType=JSON.parse(wire).type;state.diagnosticPayloadKeys=Object.keys(JSON.parse(wire).payload);log('diagnostic-sent',{event:payload.event});} } };
    const wirePeer = (pc, remoteId) => {
      pcRef=pc;
      pc.onicecandidate = event => {
        if(pcRef!==pc)return;
        if (!event.candidate) return;
        const type=event.candidate.type;
        if(type&&!state.candidateTypes.includes(type)){state.candidateTypes.push(type);log('candidate-gathered',{type});}
        signal(remoteId,'ice',{candidate:event.candidate});
      };
      pc.oniceconnectionstatechange = async () => {
        log('ice-state',{state:pc.iceConnectionState});
        if(pc.iceConnectionState==='connected'||pc.iceConnectionState==='completed'){
          const stats=await pc.getStats();
          const pair=[...stats.values()].find(item=>item.type==='candidate-pair'&&item.selected)||[...stats.values()].find(item=>item.type==='candidate-pair'&&item.nominated&&item.state==='succeeded');
          if(pair){const local=stats.get(pair.localCandidateId),remote=stats.get(pair.remoteCandidateId);state.candidatePair={state:pair.state,localType:local?.candidateType,remoteType:remote?.candidateType};log('candidate-pair-selected',state.candidatePair);}
        }
      };
      pc.onconnectionstatechange=()=>log('connection-state',{state:pc.connectionState});
    };
    const flushIce = async pc => { for(const candidate of state.queuedIce.splice(0)){await pc.addIceCandidate(candidate);} };
    const setupChannel = dc => {
      dcRef=dc;
      dc.onopen=()=>{state.open=true;log('datachannel-open');if(role==='host'){const snapshotId='smoke-snapshot-'+state.sessionId;dc.send(JSON.stringify({type:'snapshot',snapshotId,state:{campaign:{name:'Lantern RTC Smoke'},scene:{id:'scene_latest',locationId:'location_crypt',title:'Flooded Crypt'}}}));log('snapshot-sent',{snapshotId});window.__lanternRtcSmokePingAgain();}};
      dc.onclose=()=>log('datachannel-closed');
      dc.onmessage=event=>{const message=JSON.parse(event.data);if(role==='player'&&message.type==='snapshot'){const parsed=JSON.parse(JSON.stringify(message.state));if(parsed.campaign?.name!=='Lantern RTC Smoke')throw Error('canonical snapshot mismatch');if(parsed.scene?.id!=='scene_latest'||parsed.scene?.locationId!=='location_crypt')throw Error('reconnect snapshot regressed from the current canonical scene');state.snapshotId=message.snapshotId;state.sceneId=parsed.scene.id;log('snapshot-received-and-applied',{snapshotId:message.snapshotId,sceneId:state.sceneId});dc.send(JSON.stringify({type:'snapshot_ack',snapshotId:message.snapshotId}));log('snapshot-ack-sent',{snapshotId:message.snapshotId});}if(role==='host'&&message.type==='snapshot_ack'){log('snapshot-ack-received',{snapshotId:message.snapshotId});dc.send(JSON.stringify({type:'snapshot_ack_received',snapshotId:message.snapshotId}));}if(role==='player'&&message.type==='snapshot_ack_received'){state.snapshotAckConfirmed=true;log('snapshot-ack-confirmed',{snapshotId:message.snapshotId});}if(role==='player'&&message.type==='ping'){dc.send(JSON.stringify({type:'pong',nonce:message.nonce}));log('ping-received');}if(role==='host'&&message.type==='pong'&&message.nonce?.startsWith('lantern-smoke-')){state.pongs++;state.pong=true;log('pong-received',{count:state.pongs});}};
    };
    const handleSignal = async message => {
      if(message.type==='presence') { log('presence',{event:message.event}); return; }
      const payload=message.payload||{};
      if(payload.kind==='hello'&&role==='host'){
        if(state.playerSessionId===payload.sessionId&&pcRef&&!['failed','closed'].includes(pcRef.connectionState)){log('duplicate-hello-ignored');return;}
        if(pcRef){try{pcRef.close();}catch{};try{dcRef?.close();}catch{};}
        state.playerSessionId=payload.sessionId;
        log('hello-received');
        const pc=new RTCPeerConnection({iceServers});wirePeer(pc,message.sender);
        setupChannel(pc.createDataChannel('smoke',{ordered:true}));
        const offer=await pc.createOffer();await pc.setLocalDescription(offer);log('offer-sent');signal(message.sender,'offer',{sdp:pc.localDescription});
      } else if(payload.kind==='offer'&&role==='player'){
        log('offer-received');state.remotePeer=message.sender;
        const pc=new RTCPeerConnection({iceServers});wirePeer(pc,message.sender);
        pc.ondatachannel=event=>setupChannel(event.channel);
        await pc.setRemoteDescription(payload.sdp);await flushIce(pc);
        const answer=await pc.createAnswer();await pc.setLocalDescription(answer);log('answer-sent');signal(message.sender,'answer',{sdp:pc.localDescription});
      } else if(payload.kind==='answer'&&role==='host'){
        log('answer-received');await pcRef.setRemoteDescription(payload.sdp);await flushIce(pcRef);
      } else if(payload.kind==='ice'&&payload.candidate){
        if(pcRef?.remoteDescription)await pcRef.addIceCandidate(payload.candidate);else state.queuedIce.push(payload.candidate);
      }
    };
    (async()=>{
      try{
        const config=await fetch('/api/ice',{cache:'no-store'}).then(response=>{if(!response.ok)throw Error('ICE config HTTP '+response.status);return response.json();});
        iceServers=config.iceServers;
        const scheme=location.protocol==='https:'?'wss':'ws';
        const url=scheme+'://'+location.host+'/ws/room/'+encodeURIComponent(room)+'/'+encodeURIComponent(state.peer)+'?role='+role;
        const connectSignal=()=>{socket=new WebSocket(url);socket.onopen=()=>{log('signaling-connected');signal('*','diagnostic',{event:'smoke-log-probe',role,peer:state.peer.slice(-8),signalingWebSocketState:'open',connectionState:'new',iceConnectionState:'new',iceGatheringState:'new',signalingState:'stable',candidateTypes:[],candidatePair:null,dataChannelReadyState:'connecting'});if(role==='player')signal('host','hello',{name:'smoke player',sessionId:state.sessionId});};socket.onmessage=event=>handleSignal(JSON.parse(event.data)).catch(error=>{state.error=String(error);});socket.onerror=()=>{state.error='signaling websocket error';};socket.onclose=event=>log('signaling-closed',{code:event.code});};
        if(role==='host')window.__lanternRtcSmokePingAgain=()=>{if(dcRef?.readyState==='open'){state.pings++;dcRef.send(JSON.stringify({type:'ping',nonce:'lantern-smoke-'+state.pings}));}};
        if(role==='player')window.__lanternRtcSmokeReconnectSignal=()=>{socket?.close(1000);setTimeout(connectSignal,200);return 'reconnecting';};
        connectSignal();
        window.__lanternRtcSmokeCleanup=()=>{socket?.close(1000);pcRef?.close();dcRef?.close();};
      } catch(error){state.error=String(error);}
    })();
    return 'started';
  })()`;
  return evalIn(session, source);
}

function ensureBrowser() {
  const result = spawnSync('agent-browser', ['--version'], { encoding: 'utf8' });
  if (result.error || result.status !== 0) {
    throw new Error('Install the agent-browser CLI and Chromium to run this two-browser WebRTC smoke test.');
  }
}

try {
  ensureBrowser();
  browser(hostSession, 'open', baseUrl);
  browser(playerSession, 'open', baseUrl);
  startClient(hostSession, 'host', hostPeer);
  await waitFor(() => { const state=readState(hostSession); return {...state,done:state.events.some(event=>event.event==='signaling-connected')}; }, 'Host signaling connection');
  const initialPlayerSessionId=randomUUID();
  startClient(playerSession, 'player', playerPeer, hostPeer, initialPlayerSessionId);
  let host = await waitFor(() => { const state=readState(hostSession); return {...state,player:readState(playerSession),done:state.pongs>=1}; }, 'Initial WebRTC DataChannel ping/pong');
  let player = readState(playerSession);
  player = await waitFor(() => { const state=readState(playerSession); return {...state,done:state.snapshotAckConfirmed===true}; }, 'Initial canonical snapshot ACK confirmation');
  if (!host.open || !player.open || !host.candidatePair) throw new Error(`Initial connection incomplete. Host=${JSON.stringify(host)}, player=${JSON.stringify(player)}`);
  if (!host.events.some(event=>event.event==='snapshot-ack-received')) throw new Error('Host did not receive the canonical snapshot ACK.');

  evalIn(playerSession, 'window.__lanternRtcSmokeReconnectSignal()');
  await waitFor(() => { const state=readState(hostSession); return {...state,done:state.events.some(event=>event.event==='duplicate-hello-ignored')}; }, 'Signaling reconnect while DataChannel remains active');
  evalIn(hostSession, 'window.__lanternRtcSmokePingAgain()');
  host = await waitFor(() => { const state=readState(hostSession); return {...state,done:state.pongs>=2}; }, 'DataChannel after signaling reconnect');

  evalIn(playerSession, 'window.__lanternRtcSmokeCleanup();"closed"');
  browser(playerSession, 'close');
  browser(refreshedPlayerSession, 'open', baseUrl);
  startClient(refreshedPlayerSession, 'player', playerPeer, hostPeer, randomUUID());
  host = await waitFor(() => { const state=readState(hostSession); return {...state,done:state.pongs>=3&&state.events.filter(event=>event.event==='snapshot-ack-received').length>=2}; }, 'Player refresh and reconnect with snapshot ACK');
  player = readState(refreshedPlayerSession);
  player = await waitFor(() => { const state=readState(refreshedPlayerSession); return {...state,done:state.snapshotAckConfirmed===true}; }, 'Refreshed player canonical snapshot ACK confirmation');
  const offerCount=host.events.filter(event=>event.event==='offer-sent').length;
  if (!player.open || offerCount!==2) throw new Error(`Expected one offer per player page session (two total after refresh), received ${offerCount}.`);
  if (host.pings!==3) throw new Error(`Expected one ping per DataChannel open plus one after signaling reconnect, got ${host.pings}.`);
  if (!host.candidatePair) throw new Error('No selected host candidate pair was reported.');
  console.log(JSON.stringify({
    result: 'passed',
    room,
    hostEvents: host.events.map(event => event.event),
    playerEvents: player.events.map(event => event.event),
    hostCandidateTypes: host.candidateTypes,
    playerCandidateTypes: player.candidateTypes,
    selectedCandidatePair: host.candidatePair,
    pingPong: host.pongs,
    snapshotAck: host.events.filter(event=>event.event==='snapshot-ack-received').length>=2&&player.snapshotAckConfirmed,
    diagnosticsSent: {host:host.diagnosticSentType==='diagnostic',player:player.diagnosticSentType==='diagnostic'},
    playerRefreshReconnect: player.open,
    signalingReconnectWithoutRenegotiation: host.events.some(event=>event.event==='duplicate-hello-ignored')&&offerCount===2,
  }, null, 2));
} finally {
  for (const session of [hostSession, playerSession, refreshedPlayerSession]) {
    try { evalIn(session, 'window.__lanternRtcSmokeCleanup?.();"closed"'); } catch {}
    try { browser(session, 'close'); } catch {}
  }
}
