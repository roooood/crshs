var colyseus = require('colyseus'),
    CryptoJS = require("crypto-js"),
    request = require("request"),
    BigNumber = require('bignumber.js'),
    Connection = require('./connection');

class State {
    constructor() {
        this.started = false;
        this.players = {};
        this.online = 0;
        this.counting = false;
        this.history = [];
        this.message = [];
    }
}
class Server extends colyseus.Room {
    constructor(options) {
        super(options);
        this.Counter = 0;
        this.count = 0;
        this.crashing = .99;

        this.gift = null;
        this.setting = {};
        this.players = {};
        this.fakeUser = {};

        this.crash = {
            player: 0,
            inline: 0,
            total: 0,
            bank: 0,
            first: true,
            prevPoint: 0,
            prevState: 'min'
        }
        this.apiUrl = 'http://localhost:4999/api/webservices/';

        this.preStart = this.preStart.bind(this);
        this.start = this.start.bind(this);
        this.end = this.end.bind(this);
        this.calculate = this.calculate.bind(this);
    }
    async onInit(options) {
        this.setState(new State);
        await Connection.query('SELECT * FROM `crash_setting` LIMIT 1')
            .then(results => {
                this.configSetting(results[0])
            });
        Connection.query('SELECT * FROM `crash_points` ORDER BY `id` DESC LIMIT 20')
            .then(results => {
                let res, data = [];
                for (res of results) {
                    data.push({
                        id: res.id,
                        point: res.point,
                        hash: CryptoJS.MD5('' + res.id).toString()
                    })
                }

                this.state.history = data;
            });
        Connection.query('SELECT `userId`,`username` FROM `users` where `is_fake`=1')
            .then(results => {
                let res;
                for (res of results) {
                    this.fakeUser[res.userId] = res.username
                }
            });
        this.checkMessage();
        this.setTimer(this.preStart, 2000);

    }
    configSetting(setting) {
        this.setting = setting;
        this.setting.minPoint = this.setting.minPoint.split(',').map(v => parseFloat(v.replace(/^\s+|\s+$/g, '')))
        this.setting.maxPoint = this.setting.maxPoint.split(',').map(v => parseFloat(v.replace(/^\s+|\s+$/g, '')))
        this.setting.giftCash = this.setting.giftCash.split(',').map(v => v.replace(/^\s+|\s+$/g, ''));

        this.state.online = this.setting.fakeUserCount;
    }
    requestJoin(options, isNewRoom) {
        return (options.create) ?
            (options.create && isNewRoom) :
            this.clients.length > 0;
    }
    async onAuth(options) {
        let ret = {
            guest: true
        };
        if (options.key != 0)
            await Connection.query('SELECT * FROM `users` LEFT JOIN `crash_users` ON `crash_users`.`uid` = `users`.`userId` LEFT JOIN `wallets` ON `users`.`token` = `wallets`.`token` where `users`.`token`=? LIMIT 1', [options.key])
                .then(results => {
                    if (results[0] != null) {
                        ret = {
                            id: results[0].userId,
                            name: results[0].username,
                            balance: results[0].balance
                        };
                        if (results[0].admin == 1) {
                            ret.admin = true;
                        }
                        else if (results[0].mute == 1) {
                            ret.mute = true;
                        }
                    }
                }, e => {
                    ret = {
                        guest: true
                    };
                });
        return ret;
    }
    onJoin(client, options, auth) {

        if ('guest' in auth) {
            client.guest = true;
            client.mute = true;
            this.send(client, {
                welcome: {
                    balance: -1,
                    name: 'guest',
                    minBet: this.setting.minbet,
                    maxBet: this.setting.maxbet,
                }
            });
        } else {
            client.guest = false;
            for (let i in auth)
                client[i] = auth[i];
            this.send(client, {
                welcome: {
                    id: client.id,
                    balance: client.balance,
                    name: client.name,
                    admin: ('admin' in auth),
                    minBet: this.setting.minbet,
                    maxBet: this.setting.maxbet
                }
            });
        }


        let cl;
        for (cl of this.clients) {
            if (!cl.guest && (cl.id == client.id && client.sessionId != cl.sessionId)) {
                client.close();
            }
        }

        this.state.online = this.state.online + 1;
    }
    onMessage(client, message) {
        let type = Object.keys(message)[0];
        if (client.guest == true && type != 'point') {
            return;
        }

        let value = message[type];
        switch (type) {
            case 'bet':
                this.bet(client, value)
                break;
            case 'cancel':
                this.cancel(client)
                break;
            case 'done':
                this.done(client, value)
                break;
            case 'chat':
                if (!('mute' in client))
                    this.chat(client, value)
                break;
            case 'myGift':
                this.myGift(client, value)
                break;
            case 'point':
                this.getPointResult(client, value);
                break;
            case 'mute':
                if ('admin' in client)
                    this.muteUser(value);
                break;
            case 'delete':
                if ('admin' in client)
                    this.deleteChat(value);
                break;
        }
    }
    onLeave(client, consented) {
        this.state.online = this.state.online - 1;
    }
    onDispose() {

    }
    getPointResult(client, pid) {
        Connection.query('SELECT `crash_result`.*,`users`.username FROM `crash_result` LEFT JOIN `users`  ON `crash_result`.`uid`=`users`.`userId`  WHERE `crash_result`.`pid` = ?', [pid])
            .then(results => {
                let res, data = {};
                for (res of results) {
                    data[res.uid] = {
                        name: res.uid > 0 ? res.username : this.fakeUser[Math.abs(res.uid)],
                        bet: res.cash,
                        stop: res.stop,
                        cashOut: res.cash + res.cashout
                    }
                }
                this.send(client, { pointInfo: data })
            });
    }
    objectsEqual(o1, o2) {
        return Object.keys(o1).every(key => o1[key] == o2[key]);
    }
    arraysEqual(a1, a2) {
        return a1.length === a2.length && a1.every((o, idx) => this.objectsEqual(o, a2[idx]));
    }
    checkMessage() {
        let len = this.state.message.length;
        if (len == 0)
            len = 10;
        Connection.query('SELECT  `crash_message`.*,`users`.`username` FROM `crash_message`  LEFT JOIN `users`  ON `crash_message`.`uid`=`users`.`userId`  ORDER BY `crash_message`. `id` DESC LIMIT ' + len)
            .then(results => {
                let res, data = [];
                for (res of results) {
                    data.push({
                        id: res.id,
                        uid: res.uid,
                        sender: res.username,
                        message: res.text
                    })
                }
                if (!this.arraysEqual(data, this.state.message)) {
                    this.state.message = data;
                }
            });
    }
    preStart() {
        this.players = {};
        this.state.players = {};

        this.crash.player = 0;
        this.crash.bank = 0;
        this.crash.prevPoint = this.crashAt;

        // if (this.gift != null) {
        //     if (this.gift.type != 2) {
        //         let index = this.userById(this.gift.user);
        //         if (index !== false) {
        //             this.send(this.clients[index], { gift: this.gift.type })
        //         }
        //     }
        // }

        let timer = this.setting.timer;
        this.state.counting = timer;
        this.broadcast({
            timer: timer
        });

        if (this.random(2) == 1) {
            Connection.query('SELECT * FROM `crash_setting` LIMIT 1')
                .then(results => {
                    this.configSetting(results[0]);
                });
            this.checkMessage();
        }
        this.readyFakeUsers();
        this.setTimer(this.start, timer * 1000);
    }
    start() {
        let min = true;
        this.crashOut = [];
        this.state.started = true;
        this.state.counting = false;

        this.crash.total = this.add(this.crash.bank, this.crash.total);
        this.crash.inline = this.crash.player;
        this.crash.first = true;


        this.checkNextGift();

        if (this.crash.total > this.setting.incomeState) {
            if (this.haveChance()) {
                min = false;
            }
        }
        if (this.crash.prevState == 'min') {
            if (this.haveChance()) {
                min = true;
            }
        }
        if (this.crash.player == 0) {
            if (this.haveChance()) {
                min = false;
            }
        }

        let crashOut = min ? this.setting.minPoint : this.setting.maxPoint;
        this.crashAt = crashOut[this.random(crashOut.length, 0)];
        this.count = 0;
        this.crashing = .99;
        this.tick = this.lastTick = 1;
        this.timer = this.clock.setInterval(this.calculate, 100);
        this.crash.prevState = min ? 'min' : 'max';
    }
    calculate() {
        this.count += 1;
        this.crashing = Math.pow(1.075, Math.round(this.count) / 10);
        if (this.crashing > this.crashAt) {
            this.crashing = this.crashAt;
        }
        this.tick = this.crashing.toFixed(2);
        this.checkUserPayOut();
        this.lastTick = this.tick;

        if (this.crashing == this.crashAt) {
            if (this.haveChance() && this.crash.player > 0 && this.crash.first) {
                if (this.crash.inline <= this.setting.playerState && this.crash.player > 5) {
                    this.incCrash();
                    this.crash.first = false;
                }
                else {
                    this.clearTimer();
                    this.end();
                }
            }
            else {
                this.clearTimer();
                this.end();
            }
        }

        this.broadcast({ c: this.tick })
    }
    end() {
        this.state.started = false;
        if (this.gift != null && this.gift.type == 2) {
            this.gift = false;
        }
        if (Object.keys(this.players).length) {
            this.Counter++;

            let date = new Date().toISOString().replace(/T/, ' ').replace(/\..+/, '');
            let point = {
                point: this.crashAt, time: date
            }
            Connection.query('INSERT INTO `crash_points` SET ?', point)
                .then(results => {
                    Connection.query('SELECT LAST_INSERT_ID() AS `last_id` ')
                        .then(result => {
                            let id = result[0]['last_id'];
                            this.addResult(id);
                            this.updateHistory(id);
                            //this.checkGift();
                        });
                });

        }
        this.setTimer(this.preStart, 3000);

    }
    incCrash() {
        let prev = this.crashAt * 100 + 100;
        this.crashAt = this.random(1000, prev) / 100;
    }
    readyFakeUsers() {
        if (this.setting.fakeUserCount > 0) {
            let users, i, len, time, bet;
            users = this.getRandomUser(this.setting.fakeUserMin, this.setting.fakeUserCount);
            time = (this.setting.timer - 1) * 1000
            len = users.length - 1;
            for (i = 0; i < len; i++) {
                bet = (Math.random() * (this.setting.maxbet / 5) + this.setting.minbet);
                var self = this;
                (function (user, bet) {
                    setTimeout(function () {
                        self.state.players['_' + user] = {
                            name: self.fakeUser[user],
                            bet: self.add(bet, 0),
                            stop: 0
                        };
                        let stop = (Math.random() * self.random(15) + 1).toFixed(2)
                        self.players['_' + user] = {
                            stop: parseFloat(stop),
                            isFake: true
                        };
                    }, Math.floor(Math.random() * time));
                })(users[i], bet);
            }
        }
    }
    checkUserPayOut() {
        let i;
        let tick = parseFloat(this.tick);
        for (i in this.players) {
            let payOut = this.players[i].stop;
            if (this.state.players[i].stop == 0) {
                if (payOut == tick || (payOut < tick && payOut > this.lastTick)) {
                    this.betDone(i, payOut);
                    if ('isFake' in this.players[i]) {
                        this.crash.inline--;
                    }
                }
            }
        }
    }
    haveChance() {
        return this.random(this.setting.chance, 0) == 0;
    }
    random(max, min = 1) {
        return Math.floor(Math.random() * max) + min;
    }
    checkNextGift() {
        if (this.gift != null) {
            if (this.gift.type != 2) {
                this.gift = null;
            } else {
                let index = this.userById(this.gift.user);
                if (index !== false && ('_' + this.gift.user in this.players)) {
                    this.send(this.clients[index], { gift: this.gift.type })
                }
            }
        }
    }
    myGift(client, val) {
        let cash,
            index = this.userById(this.gift.user),
            user = this.clients[index].id;
        if (this.gift != null && user == client.id) {

            if (this.gift.type == 1 && ('giftCash' in this.setting)) {
                cash = parseInt(this.setting.giftCash[this.random(this.setting.giftCash.length, 0)]);
                this.send(client, { giftResult: cash });
                client.balance += cash;
                this.send(client, { balance: client.balance });
                this.updateUserBalance(client.id, client.balance, cash);
            }
            else if (this.gift.type == 2) {
                if ('_' + client.id in this.players && this.state.players['_' + client.id].stop == 0) {
                    cash = parseInt(val);
                    this.state.players['_' + client.id].bet += cash;
                    this.send(client, { betAmount: this.state.players['_' + client.id].bet });

                }
            }
            else if (this.gift.type == 3) {
                Connection.query('SELECT * FROM `crash_result` WHERE `uid` = ? ORDER BY `id` DESC LIMIT 1', [client.id])
                    .then(result => {
                        if (result[0] != null) {
                            cash = parseInt(result[0]['cash']);
                            this.send(client, { giftResult: cash })
                            client.balance += cash;
                            this.send(client, { balance: client.balance });
                            this.updateUserBalance(client.id, client.balance, cash);
                            //be user ezafe kon
                        }
                    });
            }
        }
    }
    checkGift() {
        if (this.Counter == this.setting.giftLimit) {
            this.Counter = 0;
            let players = [], i;
            for (i in this.players) {
                if (!('isFake' in this.players[i])) {
                    players.push(i)
                }
            }
            if (players.length == 0) {
                return;
            }
            let user = null;
            let type = this.random(3);
            if (type == 1) {
                let max = 0;
                for (i of players) {
                    if (this.state.players[i].bet > max && this.state.players[i].stop > 1) {
                        max = this.state.players[i].bet;
                        user = i.replace('_', '');
                    }
                }
            }
            else {
                let len = players.length;
                let index = this.random(len) - 1;
                user = players[index];
            }
            if (user !== false) {
                this.gift = {
                    type: type,
                    user: user
                }
            }
        }
    }
    updateHistory(id) {
        let data = this.state.history;
        if (data.length == 20) {
            data.pop();
        }
        data.unshift({
            id: id,
            point: this.crashAt,
            hash: CryptoJS.MD5('' + id, 'siavash').toString()
        })
        this.state.history = data;
    }
    addResult(id) {
        let i, j, k;
        this.broadcast({ betResult: 'done' });
        for (i in this.players) {
            j = this.players[i];
            k = this.state.players[i];
            let index = this.userById(i);
            if (k.stop == 0) {
                k.cashOut = 0;
                if (index !== false) {
                    this.send(this.clients[index], { lose: k.bet })
                }
            }
            let xid = i.replace('_', '');
            let result = {
                pid: id,
                uid: ('isFake' in j ? -xid : xid),
                balance: index !== false ? this.clients[index].balance : 0,
                stop: k.stop,
                cash: k.bet,
                cashout: k.cashOut,
                isFake: ('isFake' in j ? 1 : 0)
            }
            Connection.query('INSERT INTO `crash_result` SET ?', result);
        }

    }
    // updateUserBalance(id, balance) {
    //     let index = this.userById(id);
    //     if (index !== false)
    //         this.send(this.clients[index], { balance: balance })
    //     Connection.query('UPDATE `wallets` SET `balance`= ? WHERE `token` = (SELECT `token` FROM `users` WHERE `userId`= ? ) LIMIT 1 ', [balance, id]);
    // }

    bet(client, data) {
        if (typeof data != 'object' || this.state.started) {
            return;
        }
        let [bet, payout] = data;
        bet = this.add(bet, 0);

        if (bet < this.setting.minbet || bet > client.balance || bet > this.setting.maxbet) {
            this.send(client, { betResult: 'error' });
            return;
        }
        if ('_' + client.id in this.players) {
            return;
        }

        this.state.players['_' + client.id] = {
            name: client.name,
            bet: bet,
            stop: 0
        };
        this.players['_' + client.id] = {
            stop: parseFloat(payout),
        };
        client.balance = this.add(client.balance, -bet);

        this.crash.bank = this.add(this.crash.bank, bet);
        this.crash.player++;

        this.updateUserBalance(client.id, client.balance, -bet);
        this.send(client, { betAmount: bet })
        this.send(client, { betResult: 'bet' })

    }
    cancel(client) {
        if (this.state.started) {
            return;
        }
        else if ('_' + client.id in this.players) {
            let bet = this.state.players['_' + client.id].bet;

            client.balance = this.add(client.balance, bet);

            this.updateUserBalance(client.id, client.balance, bet);

            delete this.players['_' + client.id];
            delete this.state.players['_' + client.id];

            this.crash.bank = this.add(this.crash.bank, -bet);
            this.crash.player--;

            this.send(client, { betResult: 'cancel' })
        }
    }
    done(client) {
        if (!this.state.started)
            return;
        if ('_' + client.id in this.players) {
            let id = '_' + client.id;
            if (this.state.players[id].stop == 0) {
                this.betDone(id, this.crashing);
            }
        }
    }
    betDone(id, stop) {
        stop = Number(stop).toFixed(2);
        let bet = this.state.players[id].bet;
        let cash = (bet * Number(stop));

        this.state.players[id].cashOut = cash;
        this.state.players[id].stop = stop;

        let xid = id.replace('_', '');
        if (!('isFake' in this.players[id])) {
            let index = this.userById(xid);
            this.send(this.clients[index], { betResult: 'done' });
            this.send(this.clients[index], { win: cash })
            this.clients[index].balance = this.add(this.clients[index].balance, cash);
            this.updateUserBalance(xid, this.clients[index].balance, cash);
        }

    }
    chat(client, msg) {
        let message = {
            uid: client.id, text: msg
        }
        Connection.query('INSERT INTO `crash_message` SET ?', message)
            .then(results => {
                Connection.query('SELECT LAST_INSERT_ID() AS `last_id` ')
                    .then(result => {
                        let id = result[0]['last_id'];
                        this.state.message.unshift({
                            id: id,
                            uid: client.id,
                            sender: client.name,
                            message: msg
                        })
                    });
            });
    }
    deleteChat(id) {
        Connection.query('DELETE FROM `crash_message` WHERE `id` =  ?', [id]);
        this.checkMessage();
    }
    muteUser(user) {
        Connection.query('SELECT * FROM `crash_users` WHERE `uid` = ?', [user])
            .then(results => {
                if (results[0] == null) {
                    Connection.query('DELETE FROM `crash_message` WHERE `uid` = ?', [user]);
                    for (let i in this.clients) {
                        if (this.clients[i].id == user) {
                            this.clients[i].mute = true;
                        }
                    }
                    let message = {
                        uid: user, mute: 1
                    }
                    Connection.query('INSERT INTO `crash_users` SET ?', message);
                    this.checkMessage();
                }
            });

    }
    setTimer(callBack, timing) {
        this.timer = this.clock.setTimeout(() => callBack(), timing);
    }
    clearTimer() {
        if (this.timer != undefined) {
            this.timer.clear();
        }
    }
    userById(id) {
        let i;
        for (i in this.clients) {
            if (this.clients[i].id == id) {
                return i;
            }
        }
        return false
    }
    getRandomUser(min, max) {
        let arr = Object.keys(this.fakeUser)
        let n = Math.floor(Math.random() * (max - min)) + min;
        let len = arr.length;
        if (n > len)
            n = len;

        let result = [];
        const rndArr = arr.sort(() => 0.5 - Math.random());
        let selected = rndArr.slice(0, n);
        let i;
        for (i of selected) {
            result.push(i)
        }
        return result;
    }
    close() {
        let i;
        for (i in this.clients) {
            this.clients[i].close();
        }
    }
    num(txt) {
        let ret = 0;
        if (typeof txt == 'string')
            ret = txt.replace(/[^\d\.]*/g, '')
        else
            ret = txt;
        return parseInt(ret)
    }
    updateUserBalance(id, balance, amount) {
        let index = this.userById(id);
        if (index !== false)
            this.send(this.clients[index], { balance: balance })
        var user_token = "";
        return;
        Connection.query('SELECT * FROM `users` where `users`.`userId`=? LIMIT 1', [id])
            .then(results => {
                {
                    user_token = results[0].token;
                    var pid = 5;
                    var description;
                    var url = 'http://api.trends.bet';
                    var won = 0;
                    var odd = 0;
                    var match_id = 0;

                    if (amount != 0) {
                        if (amount > 0) {
                            description = 'برد کرش';
                        } else {
                            description = 'شروع کرش';
                        }

                        var options = {
                            method: 'POST',
                            url: url + '/api/webservices/wallet/change',
                            headers:
                            {
                                'cache-control': 'no-cache',
                                'x-access-token': user_token,
                                'content-type': 'multipart/form-data'
                            },
                            formData:
                            {
                                pid: pid,
                                user_token: user_token,
                                amount: amount,
                                description: description
                            }
                        };
                        request(options, function (error, response, body) {
                            if (error) throw new Error(error);
                        });

                        Connection.query('SELECT * FROM `crash_result` WHERE `uid` = ? ORDER BY `id` DESC LIMIT 1', [this.clients[index].id])
                            .then(result => {
                                if (result[0] != null) {
                                    match_id = result[0].id;
                                    if (amount < 0) {
                                        //store bet

                                        won = -1;
                                        var form_data = {
                                            pid: pid,
                                            user_token: user_token,
                                            amount: amount,
                                            odd: 1,
                                            sport_name: 'crash',
                                            match_id: match_id,
                                            won: won,
                                            choice: '-'
                                        };
                                        var options = {
                                            method: 'POST',
                                            url: url + '/api/webservices/bet/store',
                                            headers: {
                                                'cache-control': 'no-cache',
                                                'x-access-token': user_token,
                                                'content-type': 'multipart/form-data'
                                            },
                                            formData: form_data
                                        };
                                        request(options, function (error, response, body) {
                                            if (error) throw new Error(error);
                                        });
                                    }
                                    else {
                                        //update bet

                                        won = 2;
                                        var form_data =
                                        {
                                            pid: pid,
                                            amount: amount,
                                            user_token: user_token,
                                            odd: 1,
                                            sport_name: 'crash',
                                            match_id: match_id,
                                            won: won,
                                        }
                                        var options = {
                                            method: 'POST',
                                            url: url + '/api/webservices/bet/update',
                                            headers: {
                                                'cache-control': 'no-cache',
                                                'x-access-token': user_token,
                                                'content-type': 'multipart/form-data'
                                            },
                                            formData: form_data
                                        };
                                        request(options, function (error, response, body) {
                                            if (error) throw new Error(error);
                                        });

                                    }
                                }
                            });
                    }

                }
            }, e => {

            });
    }
    add(a, b) {
        if (a < 1 || b < 1) {
            let c = new BigNumber(a);
            let f = b < 0 ? c.minus(-1 * b) : c.plus(b);
            return f.toNumber();
        }
        return (a + b);
    }
    isFloat(amount) {
        return (amount < 1 && amount > 0)
    }
}



module.exports = Server;