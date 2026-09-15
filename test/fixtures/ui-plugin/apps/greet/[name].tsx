///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
///////////////////////////////////////////////////////////////////////////////
import React from "react";

export default function GreetNamePage({ params }: { params?: { name?: string } }) {
    return <main className="text-emerald-600">Greetings, {params?.name}</main>;
}
