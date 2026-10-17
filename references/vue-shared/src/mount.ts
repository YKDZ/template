import { createPinia } from "pinia";
import { createApp, type Component } from "vue";

export function mountApplication(component: Component): void {
  createApp(component).use(createPinia()).mount("#app");
}
