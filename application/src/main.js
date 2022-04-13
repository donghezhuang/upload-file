import Vue from 'vue'
import App from './App.vue'

import ElementUI from "element-ui";
import "element-ui/lib/theme-chalk/index.css";

import Axios from './axios'

Vue.use(ElementUI, { size: 'small'});
Vue.config.productionTip = false
Vue.prototype.$http = Axios

new Vue({
  render: h => h(App),
}).$mount('#app')
