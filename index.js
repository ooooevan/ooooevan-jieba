const fs = require('fs');
const Dict = require('./dict');


// const iconv = require('iconv-lite');
// jschardet模块可以检测编码

const log = Math.log;

class Cut {
  constructor() {
    this._loaded = false
    this.DEFAULT_DICT_ITEM = {
      dict: __dirname + '/dict/jieba.dict.utf8',
      hmmDict: __dirname + '/dict/hmm_model.utf8',
      idfDict: __dirname + '/dict/idf.utf8',
      userDict: __dirname + '/dict/user.txt',
      stopWordDict: __dirname + '/dict/stop_words.utf8'
    }
  }
  checkLoad() {
    if (!this._loaded) {
      this.load()
    }
  }
  load(options) {
    options = Object.assign(this.DEFAULT_DICT_ITEM, options)
    this.dictPath = options.dict
    this.hmmDictPath = options.hmmDict
    this.userDictPath = options.userDict
    this.idfDictPath = options.idfDict
    this.stopWordDictPath = options.stopWordDict

    this.dict = this._getDict();
    this._initProbability();

    this._loaded = true
  }
  _initProbability() {
    const model = fs.readFileSync(this.hmmDictPath).toString();
    const modelArr = model.split('\n')

    const BEMS = ['B', 'E', 'M', 'S'] //用于遍历时得到BEMS

    this.startProb = {} //初始状态概率
    this.transProb = { //转移概率矩阵相应值
      'B': {},
      'E': {},
      'M': {},
      'S': {}
    }
    this.prevTrans = { //上一个状态
      'B': ['E', 'S'],
      'E': ['B', 'M'],
      'M': ['B', 'M'],
      'S': ['E', 'S']
    }

    this.emitProb = { //所有字符对应的发射概率
      'B': {},
      'E': {},
      'M': {},
      'S': {}
    }
    // 获取初始状态概率
    const startIndex = modelArr.findIndex(item => {
      return item === '#prob_start'
    })
    const startArr = modelArr[startIndex + 1].split(' ')
    startArr.forEach((item, index) => {
      this.startProb[BEMS[index]] = +item
    })
    // 获取转移概率矩阵的概率
    const transIndex = modelArr.findIndex(item => {
      return item === '#prob_trans 4x4 matrix'
    })
    new Array(4).fill(0).forEach((_, index) => {
      const arr = modelArr[transIndex + index + 1].split(' ')
      arr.forEach((item, ind) => {
        this.transProb[BEMS[index]][BEMS[ind]] = +item
      })
    })
    // 获取字符的发射状态概率
    const emitProbStart = modelArr.findIndex(item => {
      return item === '#prob_emit 4 lines';
    })
    const emitProbArr = modelArr.slice(emitProbStart + 1).filter(i => i.length > 10);
    emitProbArr.forEach((item, index) => {
      let wordAndNumArr = item.split(',');
      wordAndNumArr.forEach(wordAndNum => {
        let word = wordAndNum.split(':')[0];
        let number = wordAndNum.split(':')[1];
        this.emitProb[BEMS[index]][word] = +number
      })
    })
  }
  _getDict() {
    const dictString = fs.readFileSync(this.dictPath).toString();
    const dictlineArr = dictString.split('\n').filter(s => s);
    const userDictString = fs.readFileSync(this.userDictPath).toString();
    const userDictlineArr = userDictString.split('\n').filter(s => s);
    const dict = new Dict();
    dict.insertArr(dictlineArr)
    dict.insertArr(userDictlineArr)
    return dict;
  }
  cut(str, options = {
    cutAll: false,
    dag: false,
    hmm: true,
    cutForSearch: false
  }) {
    this.checkLoad()
    const dag = this.getDag(str);
    if (options.dag) {
      return dag
    }
    // route记录从后往前的概率
    const route = {
      [str.length]: {
        number: 0,
        to: 0
      }
    }
    if (options.cutAll) {
      const result = []
      // 用一个set让已成词的字不再以单字出现。
      // 如：倒闭了  结果为：['倒闭', '了'] ；而不是：['倒', '倒闭', '闭','了']
      const hasInWord = new Set();
      for (let len = str.length, i = 0; i < len; i++) {
        const arr = dag[i];
        if (arr.length === 1) {
          if (!hasInWord.has(i)) {
            result.push(str.slice(i, i + 1))
            hasInWord.add(i)
          }
        } else {
          arr.forEach(x => {
            if (x !== i) {
              result.push(str.slice(i, x + 1))
              hasInWord.add(x)
            }
          })

        }
      }
      return result
    } else {
      for (let len = str.length, i = len - 1; i > -1; i--) {
        const temp = []
        const arr = dag[i];
        for (let j = 0, len = arr.length; j < len; j++) {
          let _i = arr[j];
          let _w = str.slice(i, _i + 1);
          const _node = this.dict.root[_w]
          let num
          if(typeof _node === 'object'){ //有这个词为object，有这个前缀为0，否则为undefined
            num = _node.number
          }
          let number = (log(num) || 1) - log(this.dict.total) + route[_i + 1]['number'];
          temp.push({
            number,
            to: _i
          })
        }
        route[i] = temp.sort((a, b) => {
          return b.number - a.number
        })[0]
      }
      var arr = Object.keys(route);
      const result = []
      for (let i = 0, len = arr.length; i < len; i++) {
        const arrIdx = arr[i];
        const item = route[arrIdx];
        if (item.number === 0) {
          break;
        }
        const wordLen = item.to - i + 1;
        const word = str.slice(i, i + wordLen);
        result.push(word)
        i += wordLen - 1;
      }
      let hmmResult = []
      let hmmTemp = ''
      for (let i = 0, len = result.length; i < len; i++) {
        const str = result[i];
        if (i === len - 1 || str.length !== 1) {
          if (hmmTemp) {
            hmmResult = hmmResult.concat(this.cutHMM(hmmTemp))
            hmmTemp = ''
            hmmResult.push(str);
          } else {
            hmmResult.push(str);
          }
        } else {
          hmmTemp += str
        }
      }
      if (options.cutForSearch) {
        const searchResult = []
        hmmResult.forEach(it => {
          const len = it.length
          if (len > 2) {
            for (let i = 0; i < len - 1; i++) {
              const _it = it.slice(i, i + 2)
              const _temp = this.dict.root[_it]
              if (typeof _temp === 'object') searchResult.push(_it);
            }
          }
          if (len > 3) {
            for (let i = 0; i < len - 1; i++) {
              const _it = it.slice(i, i + 3)
              const _temp = this.dict.root[_it]
              if (typeof _temp === 'object') searchResult.push(_it);
            }
          }
          searchResult.push(it);
        })
        return searchResult;
      }
      if (options.hmm) {
        return hmmResult;
      }
      return result;
    }
  }
  getDag(str) {
    this.checkLoad()
    const DAG = {}
    for (let i = 0, len = str.length; i < len; i++) {
      const w = str[i];
      const wNode = this.dict.root[w]
      if (!DAG[i]) {
        DAG[i] = [i] //每个词都可以是single
      }
      if (typeof wNode !== 'object') {
        // 遇到库中没有的特殊字符，或空格
        continue;
      }
      for (let j = i + 1; j < len; j++) {
        const _W = str.slice(i, j + 1);
        const _wNode = this.dict.root[_W]
        if (typeof _wNode === 'object') {
          DAG[i].push(j)
        } else if (_wNode === undefined) {
          break;
        }
      }
    }
    return DAG;
  }
  cutHMM(str) {
    this.checkLoad()

    /* 目前正则匹配还不完整，很多没用到，可能有错 */
    const re_userdict = /^(.+?)( [0-9]+)?( [a-z]+)?$/
    const re_eng = /[a-zA-Z0-9]/
    const re_han_default = /([\u4E00-\u9FD5a-zA-Z0-9+#&\._%]+)/
    const re_skip_default = /(\r\n|\s)/
    const re_han_cut_all = /([\u4E00-\u9FD5]+)/
    const re_skip_cut_all = /[^a-zA-Z0-9+#\n]/

    const han_reg = /([\u4E00-\u9FD5]+)/;
    const seg_reg = /([a-zA-Z0-9]+(?:\.\d)?)|([0-9]+(?:\.\d)?%?)/;

    const arr = str.split(re_han_default).filter(x => x);
    let result = []
    arr.forEach(it => {
      it.split(re_han_cut_all).filter(x => x).forEach(i => {
        if (i.match(han_reg)) {
          result = result.concat(this._cutHMM(i))
        } else {
          const _arr = i.split(re_skip_default).filter(x => x)
          _arr.forEach(i => {
            if (i.match(re_han_default)) {
              result = result.concat(i)
            } else if (re_skip_default.test(i)) {
              result = result.concat(i)
            } else {
              // 
              for (let xx of i) {
                result = result.concat(xx)
              }
            }
          })
        }
      })
    })

    return result
  }
  _cutHMM(str) {
    if (str.length === 1) {
      return [str]
    }
    let {
      correctProb,
      correctPath
    } = this._viterbi(str)
    const result = []
    let temp = ''
    correctPath.split('').forEach((type, idx) => {
      switch (type) {
        case 'B':
          temp += str[idx]
          break;
        case 'M':
          temp += str[idx]
          break;
        case 'E':
          result.push(temp + str[idx])
          temp = ''
          break;
        case 'S':
          result.push(str[idx])
          break;
      }
    })
    return result
  }
  _viterbi(sentence) {
    const V = [{}] //保存概率，一个对象一个字符
    let path = {} //保存每种计算过概率的路径
    Object.keys(this.startProb).forEach(type => {
      const firstW = sentence[0]
      const typeProb = this.startProb[type]
      const wordProb = this.emitProb[type][firstW];
      V[0][type] = typeProb + wordProb
      path[type] = [type];
    })

    for (var i = 1; i < sentence.length; i++) {
      V[i] = {}
      var word = sentence[i];
      let newpath = {}
      Object.keys(this.transProb).forEach(curType => {
        const prevTypeArr = this.prevTrans[curType]
        var temp = { //计算哪个概率高和上个type
          prob: -3.14e+100,
          prevType: ''
        };
        prevTypeArr.forEach(prevType => {
          const prevProb = V[i - 1][prevType]
          const curProb = prevProb + this.transProb[prevType][curType] + this.emitProb[curType][word]
          if (temp.prob === -3.14e+100 || curProb > temp.prob) {
            temp = {
              prob: curProb,
              prevType: prevType
            }
          }
        })
        V[i][curType] = temp.prob
        newpath[curType] = path[temp.prevType] + curType
      })
      path = newpath
    }
    const lastProb = V.pop() //最后一个字符计算出的不同type的概率，找出最合适的一个
    let correctProb, correctType
    lastProb.E > lastProb.S ? (correctProb = lastProb.E, correctType = 'E') : (correctProb = lastProb.S, correctType = 'S')
    const correctPath = path[correctType]
    return {
      correctProb,
      correctPath
    }
  }
  cutAll(str) {
    this.checkLoad()
    return this.cut(str, {
      cutAll: true
    })
  }
  cutForSearch(str) {
    this.checkLoad()
    return this.cut(str, {
      cutForSearch: true
    })
  }
  tag(str) {
    this.checkLoad()
    const arr = this.cut(str)
    const resultArr = []
    arr.forEach(word => {
      const _Node = this.dict.root[word] || {}
      resultArr.push({
        word,
        tag: _Node.tag || 'x'
      })
    })
    return resultArr;
  }
  insertWord(w, number = 1, tag = 'x') {
    this.checkLoad();
    this.dict.insertArr([w + ' ' + number + ' ' + tag])
  }
}
// var one= process.memoryUsage()
// var start = new Date()
// var sentence = "我是拖拉机学院手扶拖拉机专业的。不用多久，我就会升职加薪，当上CEO，走上人生巅峰。";
// const myjieba = new Cut()
// const res = myjieba.cut(sentence);
// console.log(res)

// var two = process.memoryUsage()
// console.log(two.heapUsed - one.heapUsed)
// console.log(new Date() - start)

module.exports = Cut
