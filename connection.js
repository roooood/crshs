// let mysql = require('mysql');
// let connection = mysql.createConnection({
//   host: 'localhost',
//   user: 'root',
//   password: 'root',
//   database: 'app',
//   port: 8889
// });
// connection.connect(function (err) {
//   if (err) {
//     console.error('error' + err);
//     return;
//   }
//   console.log('connected');
// });
// connection.end();

const mysql = require('mysql');

class Database {
  constructor(config) {
    this.connection = mysql.createConnection(config);
  }
  query(sql, args) {
    return new Promise((resolve, reject) => {
      this.connection.query(sql, args, (err, rows) => {
        if (err)
          reject(err);
        else
          resolve(rows);
      });
    });
  }
  close() {
    return new Promise((resolve, reject) => {
      this.connection.end(err => {
        if (err)
          return reject(err);
        resolve();
      });
    });
  }
}


module.exports = new Database({
  host: 'localhost',
  user: 'root',
  password: '',
  database: 'crash',
  charset: 'utf8mb4'
});