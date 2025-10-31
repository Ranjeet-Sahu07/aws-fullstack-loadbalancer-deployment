import React, { useState, useEffect } from 'react';
import './App.css';

function App() {
  const [message, setMessage] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    fetch('http://localhost:5000/api/message')
      .then(response => {
        if (!response.ok) {
          throw new Error('Failed to fetch from backend');
        }
        return response.json();
      })
      .then(data => {
        setMessage(data.message);
        setLoading(false);
      })
      .catch(err => {
        setError(err.message);
        setLoading(false);
      });
  }, []);

  return (
    <div className="App">
      <header className="App-header">
        <h1>AWS Full Stack App with Load Balancer</h1>
        {loading ? (
          <p>Loading...</p>
        ) : error ? (
          <p className="error">Error: {error}</p>
        ) : (
          <div className="message-container">
            <h2>Message from Backend:</h2>
            <p className="backend-message">{message}</p>
          </div>
        )}
      </header>
    </div>
  );
}

export default App;
