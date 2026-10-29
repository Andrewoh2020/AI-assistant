"use client";

import Link from "next/link";
import { useState } from "react";
import { Chrome } from "./Chrome";

/** The airline's home page, with a sale pop-up in the way, as on many airline sites. */
export default function PracticeAirHome() {
  const [promo, setPromo] = useState(true);
  return (
    <Chrome>
      <section className="pa-hero">
        <h1>Fly more for less</h1>
        <p>Low fares across Asia. Book, manage your booking or check in online.</p>
        <div className="pa-tabs" role="tablist">
          <span role="tab" aria-selected="true" className="pa-tab pa-tab-on">
            Flights
          </span>
          <Link role="tab" aria-selected="false" className="pa-tab" href="/practice-air/check-in">
            Check-in
          </Link>
          <span role="tab" aria-selected="false" className="pa-tab">
            Manage booking
          </span>
        </div>
        <div className="pa-card pa-search">
          <label>
            From
            <input placeholder="Singapore (SIN)" />
          </label>
          <label>
            To
            <input placeholder="Kuala Lumpur (KUL)" />
          </label>
          <label>
            Depart
            <input type="date" />
          </label>
          <button className="pa-btn" type="button">
            Search flights
          </button>
        </div>
      </section>
      <section className="pa-tiles">
        <Link className="pa-card pa-tile" href="/practice-air/check-in">
          <strong>Online check-in</strong>
          <span>Opens 24 hours and closes 1 hour before departure.</span>
        </Link>
        <div className="pa-card pa-tile">
          <strong>Add bags</strong>
          <span>Save up to 50% when you add bags before the airport.</span>
        </div>
        <div className="pa-card pa-tile">
          <strong>Hot seats</strong>
          <span>Extra legroom and be first off the plane.</span>
        </div>
      </section>
      {promo && (
        <div className="pa-modal-back">
          <div className="pa-modal" role="dialog" aria-label="Sale">
            <button className="pa-close" aria-label="Close" onClick={() => setPromo(false)}>
              ×
            </button>
            <h2>Mega sale: 30% off</h2>
            <p>Book by Sunday for 30% off flights across Asia. Terms apply.</p>
            <button className="pa-btn" onClick={() => setPromo(false)}>
              Book now
            </button>
          </div>
        </div>
      )}
    </Chrome>
  );
}
