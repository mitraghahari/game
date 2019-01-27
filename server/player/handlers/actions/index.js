/**
 * Actions from context-menu.
 * for example: (take, drop, pickup, etc.)
 */

import UI from 'shared/ui';
import uuid from 'uuid/v4';
import pipe from '../../pipeline';
import Action from '../../action';
import Map from '../../../core/map';
import Socket from '../../../socket';
import Item from '../../../core/item';
import world from '../../../core/world';
import Query from '../../../core/data/query';
import Handler from '../../../player/handler';
import Mining from '../../../core/skills/mining';
import ContextMenu from '../../../core/context-menu';
import { wearableItems, general } from '../../../core/data/items';
import { addSeconds, addHours, addMinutes } from 'date-fns';

export default {
  'player:walk-here': (data) => {
    if (data.tileWalkable) {
      Handler['player:mouseTo']({
        data: {
          id: data.player.uuid,
          coordinates: { x: data.clickedTile.x, y: data.clickedTile.y },
        },
        player: {
          socket_id: data.player.uuid,
        },
      });
    }
  },
  /**
   * A player moves to a new tile via mouse
   */
  'player:mouseTo': async (data) => {
    const movingData = Object.hasOwnProperty.call(data, 'doing') ? data : data.data;
    const { x, y } = movingData.coordinates;

    const playerId = movingData.id || data.player.id;
    const playerIndexMoveTo = world.players.findIndex(p => p.uuid === playerId);
    const matrix = await Map.getMatrix(world.players[playerIndexMoveTo]);

    world.players[playerIndexMoveTo].path.grid = matrix;
    world.players[playerIndexMoveTo].path.current.walkable = true;

    const location = movingData.location || null;

    Map.findPath(movingData.id, x, y, location);
  },
  'player:examine': (data) => {
    Socket.emit('item:examine', {
      data: { type: 'normal', text: data.item.examine },
      player: {
        socket_id: data.player.socket_id,
      },
    });
  },
  'player:inventory-drop': (data) => {
    const itemUuid = data.player.inventory.find(s => s.slot === data.data.miscData.slot).uuid;

    const playerIndex = world.players.findIndex(p => p.uuid === data.id);
    world.players[playerIndex].inventory = world.players[playerIndex].inventory
      .filter(v => v.slot !== data.data.miscData.slot);
    Socket.broadcast('player:movement', world.players[playerIndex]);

    // Add item back to the world
    // from the grasp of the player!
    world.items.push({
      id: data.item.id,
      uuid: itemUuid,
      x: world.players[playerIndex].x,
      y: world.players[playerIndex].y,
      timestamp: Date.now(),
    });

    console.log(`Dropping: ${data.item.id} at ${world.players[playerIndex].x}, ${world.players[playerIndex].x}`);

    Socket.broadcast('world:itemDropped', world.items);
  },

  /**
   * A player equips an item from their inventory
   */
  'item:equip': async (data) => {
    const playerIndex = world.players.findIndex(p => p.uuid === data.id);
    const getItem = wearableItems.find(i => i.id === data.item.id);
    const alreadyWearing = world.players[playerIndex].wear[getItem.slot];
    if (alreadyWearing) {
      await pipe.player.unequipItem({
        item: {
          uuid: alreadyWearing.uuid,
          id: alreadyWearing.id,
          slot: data.item.miscData.slot,
        },
        replacing: true,
        id: data.id,
      });

      pipe.player.equippedAnItem(data);
    } else {
      pipe.player.equippedAnItem(data);
    }
  },

  /**
   * A player unequips an item from their wear tab
   */
  'item:unequip': (data) => {
    const itemUnequipping = data.player.wear[data.item.miscData.slot];
    const newData = Object.assign(
      data,
      {
        item: {
          id: itemUnequipping.id,
          uuid: itemUnequipping.uuid,
          slot: data.item.miscData.slot,
        },
      },
    );
    pipe.player.unequipItem(newData);
  },

  /**
   * Start building the context menu for the player
   */
  'player:context-menu:build': async (incomingData) => {
    const contextMenu = new ContextMenu(
      incomingData.data.player,
      incomingData.data.tile,
      incomingData.data.miscData,
    );

    const items = await contextMenu.build();

    Socket.emit('game:context-menu:items', {
      data: items,
      player: incomingData.data.player,
    });
  },
  'player:context-menu:action': (incoming) => {
    const miscData = incoming.data.data.item.miscData || false;
    const action = new Action(incoming.data.player.socket_id, miscData);
    action.do(incoming.data.data, incoming.data.queueItem);
  },

  'player:resource:goldenplaque:push': (data) => {
    const { playerIndex } = data;

    const { id } = UI.randomElementFromArray(wearableItems);

    world.items.push({
      id,
      uuid: uuid(),
      x: 20,
      y: 108,
      timestamp: Date.now(),
    });

    Socket.broadcast('world:itemDropped', world.items);

    Socket.emit('game:send:message', {
      player: { socket_id: world.players[playerIndex].socket_id },
      text: 'You feel a magical aurora as an item starts to appear from the ground...',
    });
  },

  'player:take': (data) => {
    const { playerIndex, todo } = data;
    // eslint-disable-next-line
    const itemToTake = world.items.findIndex(e => (e.x === todo.at.x) && (e.y === todo.at.y) && (e.uuid === todo.item.uuid));

    world.items.splice(itemToTake, 1);

    Socket.broadcast('item:change', world.items);

    console.log(`Picking up: ${todo.item.id} (${todo.item.uuid.substr(0, 5)}...)`);
    const { id, graphics } = Query.getItemData(todo.item.id);

    world.players[playerIndex].inventory.push({
      slot: UI.getOpenSlot(world.players[playerIndex].inventory),
      uuid: todo.item.uuid,
      graphics,
      id,
    });

    // Add respawn timer on item (if is a respawn)
    // eslint-disable-next-line
    const resetItemIndex = world.respawns.items.findIndex(i => i.respawn && i.x === todo.at.x && i.y === todo.at.y);
    if (resetItemIndex !== -1) {
      const pickedUpAt = new Date();
      world.respawns.items[resetItemIndex].pickedUp = true;
      const respawnsIn = world.respawns.items[resetItemIndex].respawnIn;

      const add = {
        hours: Item.parseTime(respawnsIn, 'h'),
        minutes: Item.parseTime(respawnsIn, 'm'),
        seconds: Item.parseTime(respawnsIn, 's'),
      };

      let timeToAdd = 0;
      if (typeof (add.hours) === 'number') timeToAdd = addHours(pickedUpAt, add.hours);
      if (typeof (add.minutes) === 'number') timeToAdd = addMinutes(pickedUpAt, add.minutes);
      if (typeof (add.seconds) === 'number') timeToAdd = addSeconds(pickedUpAt, add.seconds);

      world.respawns.items[resetItemIndex].willRespawnIn = timeToAdd;
    }

    // Tell client to update their inventory
    Socket.emit('item:pickup', {
      player: { socket_id: world.players[playerIndex].socket_id },
      data: world.players[playerIndex].inventory,
    });
  },

  'player:resource:mining:rock': async (data) => {
    const mining = new Mining(data.playerIndex, data.todo.item.id);

    try {
      const rockMined = await mining.pickAtRock();
      const getItem = general.find(i => i.id === rockMined.resources);

      // Tell user of successful resource gathering
      Socket.sendMessageToPlayer(data.playerIndex, `You successfully mined some ${getItem.name}.`);

      // Add ore to inventory
      world.players[data.playerIndex].inventory.push({
        slot: UI.getOpenSlot(world.players[data.playerIndex].inventory),
        id: getItem.id,
        graphics: getItem.graphics,
        uuid: uuid(),
      });

      // Update the experience
      mining.updateExperience(rockMined.experience);

      // TODO
      // Change socket event to ITEM:ADDED:TO:INVENTORY
      Socket.emit('item:pickup', {
        player: { socket_id: world.players[data.playerIndex].socket_id },
        data: world.players[data.playerIndex].inventory,
      });

      // Tell client of their new experience in that skill
      Socket.emit('resource:skills:update', {
        player: { socket_id: world.players[data.playerIndex].socket_id },
        data: world.players[data.playerIndex].skills,
      });
    } catch (err) {
      Socket.sendMessageToPlayer(data.playerIndex, 'You need a pickaxe to mine rocks.');
    }
  },
};
