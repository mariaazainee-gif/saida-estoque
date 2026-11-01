// Conexao com o Firebase (auth = login, db = banco Firestore)
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js";
import { getAuth } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js";
import { getFirestore } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";

// Identificacao do projeto (nao e senha; a protecao vem das regras do Firestore)
export const firebaseConfig = {
  apiKey: "AIzaSyDrE0zjBB0vDFzjszXTpe4JjHhR873Li6c",
  authDomain: "registro-saida.firebaseapp.com",
  projectId: "registro-saida",
  storageBucket: "registro-saida.firebasestorage.app",
  messagingSenderId: "782748315921",
  appId: "1:782748315921:web:153110c166b9c1f7425cb0"
};

const app = initializeApp(firebaseConfig);

// Exporta para o main.js usar
export const auth = getAuth(app);
export const db = getFirestore(app);
